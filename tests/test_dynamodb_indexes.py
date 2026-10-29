"""Index reads and loading complete table items from projected results."""

import base64
import json
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from backend.main import app

client = TestClient(app)
RAW = b"\x00\x8e\xff"
RAW_B64 = base64.b64encode(RAW).decode("ascii")


@pytest.fixture
def ddb():
    with patch("backend.routes.dynamodb.get_client") as get_client:
        mock = MagicMock()
        get_client.return_value = mock
        mock.describe_table.return_value = {"Table": {
            "KeySchema": [{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
            "AttributeDefinitions": [
                {"AttributeName": "pk", "AttributeType": "S"},
                {"AttributeName": "sk", "AttributeType": "S"},
                {"AttributeName": "status.code", "AttributeType": "S"},
                {"AttributeName": "score-value", "AttributeType": "N"},
                {"AttributeName": "blob-key", "AttributeType": "B"},
            ],
            "GlobalSecondaryIndexes": [
                {"IndexName": "by-status", "KeySchema": [
                    {"AttributeName": "status.code", "KeyType": "HASH"},
                    {"AttributeName": "score-value", "KeyType": "RANGE"},
                ], "Projection": {"ProjectionType": "KEYS_ONLY"}},
                {"IndexName": "by-blob", "KeySchema": [{"AttributeName": "blob-key", "KeyType": "HASH"}]},
            ],
        }}
        yield mock


def test_queries_index_keys_and_preserves_all_pagination_keys(ddb):
    key = {"pk": {"S": "item"}, "sk": {"S": "revision"}, "status.code": {"S": "PAID"}, "score-value": {"N": "9007199254740993"}}
    ddb.query.side_effect = [
        {"Items": [key], "ScannedCount": 1, "LastEvaluatedKey": key},
        {"Items": [], "ScannedCount": 0},
    ]
    request = {"index_name": "by-status", "partition_key_value": "PAID", "sort_key_value": "10", "sort_key_operator": ">=", "limit": 1}
    first = client.post("/api/dynamodb/tables/users/query", json=request)
    assert first.status_code == 200
    params = ddb.query.call_args.kwargs
    assert params["IndexName"] == "by-status"
    assert params["KeyConditionExpression"] == "#pk = :pk AND #sk >= :sk"
    assert params["ExpressionAttributeNames"] == {"#pk": "status.code", "#sk": "score-value"}
    assert params["ExpressionAttributeValues"] == {":pk": {"S": "PAID"}, ":sk": {"N": "10"}}
    assert "ConsistentRead" not in params
    assert "ExclusiveStartKey" not in params
    second = client.post("/api/dynamodb/tables/users/query", json={**request, "exclusive_start_key": first.json()["next_token"]})
    assert second.status_code == 200
    assert second.json()["next_token"] is None
    assert ddb.query.call_args.kwargs["IndexName"] == "by-status"
    assert ddb.query.call_args.kwargs["ExclusiveStartKey"] == key


def test_queries_a_hash_only_binary_index(ddb):
    ddb.query.return_value = {"Items": [{"blob-key": {"B": RAW}}]}
    response = client.post("/api/dynamodb/tables/users/query", json={"index_name": "by-blob", "partition_key_value": RAW_B64})
    assert response.status_code == 200
    assert response.json()["items"] == [{"blob-key": {"B": RAW_B64}}]
    params = ddb.query.call_args.kwargs
    assert params["IndexName"] == "by-blob"
    assert params["ExpressionAttributeNames"] == {"#pk": "blob-key"}
    assert params["ExpressionAttributeValues"] == {":pk": {"B": RAW}}


def test_unknown_index_does_not_fall_back_to_table_keys(ddb):
    response = client.post("/api/dynamodb/tables/users/query", json={"index_name": "missing", "partition_key_value": "a"})
    assert response.status_code == 400
    assert "does not exist" in response.json()["detail"]
    ddb.query.assert_not_called()


def test_scans_index_and_round_trips_binary_continuation_key(ddb):
    key = {"pk": {"S": "item"}, "sk": {"S": "revision"}, "blob-key": {"B": RAW}}
    ddb.scan.side_effect = [{"Items": [key], "LastEvaluatedKey": key}, {"Items": []}]
    first = client.get("/api/dynamodb/tables/users/items", params={"index_name": "by-blob", "limit": 1})
    assert first.status_code == 200
    assert ddb.scan.call_args.kwargs == {"TableName": "users", "IndexName": "by-blob", "Limit": 1}
    second = client.get("/api/dynamodb/tables/users/items", params={"index_name": "by-blob", "limit": 1, "exclusive_start_key": first.json()["next_token"]})
    assert second.status_code == 200
    assert ddb.scan.call_args.kwargs == {"TableName": "users", "IndexName": "by-blob", "Limit": 1, "ExclusiveStartKey": key}
    assert second.json()["next_token"] is None


def test_loads_complete_base_item_with_binary_key_even_when_writes_are_disabled(ddb):
    key = {"pk": {"B": RAW}, "sk": {"N": "9007199254740993"}}
    item = {**key, "not_projected": {"M": {"blob": {"B": RAW}}}}
    ddb.get_item.return_value = {"Item": item}
    with patch("backend.main.STACKPORT_ALLOW_WRITES", False):
        response = client.get("/api/dynamodb/tables/users/item", params={"key": json.dumps({"pk": {"B": RAW_B64}, "sk": key["sk"]})})
    assert response.status_code == 200
    assert response.json()["item"]["not_projected"] == {"M": {"blob": {"B": RAW_B64}}}
    ddb.get_item.assert_called_once_with(TableName="users", Key=key, ConsistentRead=True)


@pytest.mark.parametrize("key", ["invalid", "null", "[]", "{}", '{"pk":{"S":"a"}}'])
def test_rejects_invalid_or_incomplete_primary_keys(ddb, key):
    response = client.get("/api/dynamodb/tables/users/item", params={"key": key})
    assert response.status_code == 400
    ddb.get_item.assert_not_called()


def test_missing_base_item_returns_404(ddb):
    ddb.get_item.return_value = {}
    response = client.get("/api/dynamodb/tables/users/item", params={"key": json.dumps({"pk": {"S": "gone"}, "sk": {"S": "revision"}})})
    assert response.status_code == 404
    assert "no longer exists" in response.json()["detail"]
