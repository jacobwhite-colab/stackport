"""Native index scans with recovery for emulators that scan the base table."""

from dataclasses import dataclass
from typing import Any

from botocore.exceptions import ClientError


@dataclass
class ScanPage:
    items: list[dict[str, Any]]
    scanned_count: int
    next_key: dict[str, Any] | None
    compatibility: bool = False
    restarted: bool = False


def _valid_key(item: dict[str, Any], names: set[str], types: dict[str, str]) -> bool:
    for name in names:
        attribute = item.get(name)
        if not isinstance(attribute, dict) or len(attribute) != 1:
            return False
        value = attribute.get(types.get(name, "S"))
        if value is None or value == "" or value == b"":
            return False
    return True


def _project(items: list[dict[str, Any]], index: dict[str, Any], keys: set[str]) -> list[dict[str, Any]]:
    projection = index.get("Projection", {})
    if projection.get("ProjectionType", "ALL") == "ALL":
        return items
    attributes = keys | set(projection.get("NonKeyAttributes", []))
    return [{name: value for name, value in item.items() if name in attributes} for item in items]


def _compatibility_scan(
    dynamodb: Any, name: str, limit: int, start_key: dict[str, Any] | None,
    index: dict[str, Any], base_keys: set[str], index_keys: set[str], types: dict[str, str],
) -> ScanPage:
    # A table scan has a base-table cursor, even when its filter excludes the
    # last evaluated item. Never send that cursor back to an index scan.
    names = {f"#ik{i}": key for i, key in enumerate(sorted(index_keys))}
    params: dict[str, Any] = {
        "TableName": name,
        "FilterExpression": " AND ".join(f"attribute_exists({alias})" for alias in names),
        "ExpressionAttributeNames": names,
    }
    projection = index.get("Projection", {})
    if projection.get("ProjectionType", "ALL") != "ALL":
        projected = base_keys | index_keys | set(projection.get("NonKeyAttributes", []))
        projection_names = {f"#p{i}": key for i, key in enumerate(sorted(projected))}
        params["ExpressionAttributeNames"] = {**names, **projection_names}
        params["ProjectionExpression"] = ", ".join(projection_names)

    items: list[dict[str, Any]] = []
    scanned_count = 0
    next_key = start_key
    visited: set[str] = set()
    while True:
        signature = repr(sorted((next_key or {}).items()))
        if signature in visited:
            raise ValueError("Scan pagination did not advance")
        visited.add(signature)
        request = {**params, "Limit": limit - len(items)}
        if next_key:
            request["ExclusiveStartKey"] = next_key
        response = dynamodb.scan(**request)
        raw_items = response.get("Items", [])
        # Check membership and projection locally too: affected emulators may
        # ignore filters or return unprojected base-table attributes.
        items.extend(item for item in raw_items if _valid_key(item, base_keys | index_keys, types))
        scanned_count += response.get("ScannedCount", len(raw_items))
        next_key = response.get("LastEvaluatedKey") or None
        if next_key and not _valid_key(next_key, base_keys, types):
            raise ValueError("Emulator returned an invalid table scan cursor")
        if len(items) >= limit or not next_key:
            return ScanPage(_project(items, index, base_keys | index_keys), scanned_count, next_key, compatibility=True)


def scan_items(
    dynamodb: Any, name: str, limit: int, index_name: str | None,
    start_key: dict[str, Any] | None, compatibility: bool = False, allow_compatibility: bool = False,
) -> ScanPage:
    params: dict[str, Any] = {"TableName": name, "Limit": limit}
    if start_key:
        params["ExclusiveStartKey"] = start_key
    if not index_name:
        response = dynamodb.scan(**params)
        items = response.get("Items", [])
        return ScanPage(items, response.get("ScannedCount", len(items)), response.get("LastEvaluatedKey") or None)

    table = dynamodb.describe_table(TableName=name)["Table"]
    indexes = table.get("GlobalSecondaryIndexes", []) + table.get("LocalSecondaryIndexes", [])
    index = next((index for index in indexes if index["IndexName"] == index_name), None)
    if not index:
        raise ValueError(f"Index {index_name!r} does not exist on this table")
    base_keys = {key["AttributeName"] for key in table.get("KeySchema", [])}
    index_keys = {key["AttributeName"] for key in index.get("KeySchema", [])}
    types = {attribute["AttributeName"]: attribute["AttributeType"] for attribute in table.get("AttributeDefinitions", [])}
    if not base_keys or not index_keys:
        raise ValueError("Missing table or index key schema")
    if start_key is not None and not _valid_key(start_key, base_keys, types):
        raise ValueError("Invalid scan pagination key")
    if compatibility:
        if not allow_compatibility:
            raise ValueError("Compatibility cursors require an emulator endpoint")
        return _compatibility_scan(dynamodb, name, limit, start_key, index, base_keys, index_keys, types)

    params["IndexName"] = index_name
    required = base_keys | index_keys
    malformed = start_key is not None and not _valid_key(start_key, required, types)
    if not malformed:
        try:
            response = dynamodb.scan(**params)
        except ClientError as error:
            message = error.response.get("Error", {}).get("Message", "").lower()
            if not (start_key and error.response.get("Error", {}).get("Code") == "ValidationException"
                    and ("starting key" in message or "key element" in message)):
                raise
            malformed = True
        else:
            items = response.get("Items", [])
            next_key = response.get("LastEvaluatedKey") or None
            malformed = any(not _valid_key(item, required, types) for item in items)
            malformed = malformed or (next_key is not None and not _valid_key(next_key, required, types))
            if not malformed:
                return ScanPage(_project(items, index, required), response.get("ScannedCount", len(items)), next_key)

    if not allow_compatibility:
        raise ValueError("Index scan returned items or a cursor missing required index keys")
    # Restart from the beginning rather than mixing native index ordering with
    # base-table ordering and silently skipping or duplicating records.
    page = _compatibility_scan(dynamodb, name, limit, None, index, base_keys, index_keys, types)
    page.restarted = True
    return page
