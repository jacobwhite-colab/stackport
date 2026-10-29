"""Sparse index scans against a real DynamoDB emulator and legacy scan faults."""

import base64
import json
from unittest.mock import patch

import boto3
import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient
from moto import mock_aws

from backend.main import app
from backend.routes.common import EndpointInfo, get_endpoint_info

client = TestClient(app)
TABLE = "sparse-cache"
INDEX = "revision_link_cache_version_index"
BASE_KEYS = {"partition_key", "item_key"}
INDEX_KEYS = {"revision_link_id", "indexed_cache_version"}


@pytest.fixture
def sparse_table():
    with mock_aws():
        ddb = boto3.client("dynamodb", region_name="us-east-1", aws_access_key_id="test", aws_secret_access_key="test")
        ddb.create_table(
            TableName=TABLE, BillingMode="PAY_PER_REQUEST",
            KeySchema=[{"AttributeName": "partition_key", "KeyType": "HASH"}, {"AttributeName": "item_key", "KeyType": "RANGE"}],
            AttributeDefinitions=[
                {"AttributeName": "partition_key", "AttributeType": "S"}, {"AttributeName": "item_key", "AttributeType": "S"},
                {"AttributeName": "revision_link_id", "AttributeType": "N"}, {"AttributeName": "indexed_cache_version", "AttributeType": "N"},
            ],
            GlobalSecondaryIndexes=[{"IndexName": INDEX, "KeySchema": [
                {"AttributeName": "revision_link_id", "KeyType": "HASH"}, {"AttributeName": "indexed_cache_version", "KeyType": "RANGE"},
            ], "Projection": {"ProjectionType": "INCLUDE", "NonKeyAttributes": ["payload"]}}],
        )
        for number in range(12):
            item = {
                "partition_key": {"S": "company#1#revision#1"}, "item_key": {"S": f"item#{number:03}"},
                "revision_link_id": {"N": "1"}, "payload": {"S": f"payload-{number}"}, "private": {"S": "not projected"},
            }
            if number % 3 == 2:
                item["indexed_cache_version"] = {"N": str(number // 3)}
            ddb.put_item(TableName=TABLE, Item=item)
        yield ddb


class LegacyIndexScan:
    """Replay older emulators' base-table index scan and cursor validation."""

    def __init__(self, ddb, fault="leaked_items"):
        self.ddb = ddb
        self.fault = fault
        self.requests = []

    def describe_table(self, **params):
        return self.ddb.describe_table(**params)

    def scan(self, **params):
        self.requests.append(params)
        if "IndexName" not in params:
            return self.ddb.scan(**params)
        if self.fault == "start_error":
            if "ExclusiveStartKey" in params:
                raise ClientError({"Error": {"Code": "ValidationException", "Message": "The provided starting key is invalid: The provided key element does not match the schema"}}, "Scan")
            return self.ddb.scan(**params)
        if self.fault == "missing_cursor":
            response = self.ddb.scan(**params)
            response["LastEvaluatedKey"].pop("indexed_cache_version")
            return response
        return self.ddb.scan(**{key: value for key, value in params.items() if key != "IndexName"})


def scan(token=None, index=INDEX, limit=2, table=TABLE):
    params = {"index_name": index, "limit": limit}
    if token:
        params["exclusive_start_key"] = token
    response = client.get(f"/api/dynamodb/tables/{table}/items", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_native_sparse_scan_excludes_missing_sort_keys_and_paginates(sparse_table):
    with patch("backend.routes.dynamodb.get_client", return_value=sparse_table), patch.object(sparse_table, "scan", wraps=sparse_table.scan) as native_scan:
        first = scan()
        second = scan(first["next_token"])
    items = first["items"] + second["items"]
    assert [item["item_key"]["S"] for item in items] == [f"item#{n:03}" for n in [2, 5, 8, 11]]
    assert items[0]["indexed_cache_version"] == {"N": "0"}
    assert all(set(item) == BASE_KEYS | INDEX_KEYS | {"payload"} for item in items)
    assert not first["reset_pagination"]
    assert second["next_token"] is None
    assert all(call.kwargs["IndexName"] == INDEX for call in native_scan.call_args_list)


@pytest.mark.parametrize("fault", ["leaked_items", "missing_cursor"])
def test_legacy_sparse_scan_recovers_with_scoped_base_table_cursors(sparse_table, fault):
    emulator = LegacyIndexScan(sparse_table, fault)
    with patch("backend.routes.dynamodb.get_client", return_value=emulator):
        first = scan()
        assert first["reset_pagination"]
        cursor = json.loads(base64.b64decode(first["next_token"]))
        assert cursor["table"] == TABLE and cursor["index"] == INDEX
        assert set(cursor["key"]) == BASE_KEYS
        second = scan(first["next_token"])
    items = first["items"] + second["items"]
    assert [item["item_key"]["S"] for item in items] == [f"item#{n:03}" for n in [2, 5, 8, 11]]
    assert all(set(item) == BASE_KEYS | INDEX_KEYS | {"payload"} for item in items)
    assert first["count"] == second["count"] == 2
    assert second["next_token"] is None
    assert not second["reset_pagination"]
    assert len([request for request in emulator.requests if "IndexName" in request]) == 1
    assert all(set(request["ExclusiveStartKey"]) == BASE_KEYS for request in emulator.requests if "IndexName" not in request and "ExclusiveStartKey" in request)


def test_invalid_index_start_key_restarts_from_the_beginning(sparse_table):
    emulator = LegacyIndexScan(sparse_table, "start_error")
    with patch("backend.routes.dynamodb.get_client", return_value=emulator):
        first = scan()
        assert not first["reset_pagination"]
        restarted = scan(first["next_token"])
        assert restarted["reset_pagination"]
        last = scan(restarted["next_token"])
    assert [item["item_key"]["S"] for item in restarted["items"] + last["items"]] == [f"item#{n:03}" for n in [2, 5, 8, 11]]
    first_table_request = next(request for request in emulator.requests if "IndexName" not in request)
    assert "ExclusiveStartKey" not in first_table_request


@pytest.mark.parametrize("target", ["other-index", None])
def test_compatibility_cursor_cannot_be_reused_for_a_different_scan(sparse_table, target):
    emulator = LegacyIndexScan(sparse_table)
    with patch("backend.routes.dynamodb.get_client", return_value=emulator):
        first = scan()
        before = len(emulator.requests)
        response = client.get(f"/api/dynamodb/tables/{TABLE}/items", params={"exclusive_start_key": first["next_token"], **({"index_name": target} if target else {})})
    assert response.status_code == 400
    assert len(emulator.requests) == before


@pytest.mark.parametrize("token", ["bad!", "W10=", "e30="])
def test_malformed_cursor_is_rejected_instead_of_restarting_the_scan(sparse_table, token):
    with patch("backend.routes.dynamodb.get_client", return_value=sparse_table), patch.object(sparse_table, "scan", wraps=sparse_table.scan) as sdk_scan:
        response = client.get(f"/api/dynamodb/tables/{TABLE}/items", params={"exclusive_start_key": token})
    assert response.status_code == 400
    sdk_scan.assert_not_called()


def test_aws_endpoint_never_falls_back_to_a_table_scan(sparse_table):
    emulator = LegacyIndexScan(sparse_table)
    app.dependency_overrides[get_endpoint_info] = lambda: EndpointInfo(url=None, region="us-east-1")
    try:
        with patch("backend.routes.dynamodb.get_client", return_value=emulator):
            response = client.get(f"/api/dynamodb/tables/{TABLE}/items", params={"index_name": INDEX, "limit": 2})
    finally:
        app.dependency_overrides.pop(get_endpoint_info)
    assert response.status_code == 400
    assert all("IndexName" in request for request in emulator.requests)
