from datetime import date, datetime, timedelta, timezone
from contextlib import contextmanager
from email.message import EmailMessage
import hashlib
import json
import logging
import math
import os
import secrets
import smtplib
import sqlite3
import urllib.parse
import urllib.error
import urllib.request
import uuid

from flask import Flask, jsonify, redirect, render_template, request, session
from werkzeug.security import check_password_hash, generate_password_hash

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "").lower() == "true",
    MAX_CONTENT_LENGTH=8 * 1024 * 1024,
)
STATE_VERSION_KEY = "_printzone_revision"
DB_PATH = os.environ.get(
    "PRINTZONE_DB_PATH",
    os.path.join(os.path.dirname(__file__), "printzone.db"),
)
OTP_TTL_MINUTES = 10
OTP_RESEND_SECONDS = 60


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS app_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                data TEXT NOT NULL
            )
        """)
        conn.execute(
            "INSERT OR IGNORE INTO app_state (id, data) VALUES (1, ?)",
            (json.dumps({}),),
        )
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                email TEXT NOT NULL COLLATE NOCASE UNIQUE,
                phone TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('Admin', 'Manager', 'User', 'Accountant', 'Customer')),
                team_id TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS password_resets (
                user_id INTEGER PRIMARY KEY,
                code_hash TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                requested_at TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """)
        conn.execute("DROP TABLE IF EXISTS login_otps")
        user_table = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'"
        ).fetchone()
        if user_table and "'User'" not in user_table["sql"]:
            conn.execute("""
                CREATE TABLE users_with_user_role (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    phone TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('Admin', 'Manager', 'User', 'Accountant', 'Customer')),
                    team_id TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
            """)
            conn.execute("""
                INSERT INTO users_with_user_role
                    (id, name, username, email, phone, password_hash, role, team_id, created_at)
                SELECT id, name, username, email, phone, password_hash, role, team_id, created_at
                FROM users
            """)
            conn.execute("DROP TABLE users")
            conn.execute("ALTER TABLE users_with_user_role RENAME TO users")


def api_error(message, status):
    return jsonify({"error": message}), status


def current_user():
    user_id = session.get("user_id")
    if not user_id:
        return None
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, name, username, email, phone, role, team_id FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    if row is None:
        session.clear()
        return None
    return dict(row)


def require_user(*roles):
    user = current_user()
    if user is None:
        return None, api_error("Please sign in to continue.", 401)
    if roles and user["role"] not in roles:
        return None, api_error("You do not have permission to do that.", 403)
    return user, None


def normalized_phone(value):
    return "".join(char for char in str(value or "") if char.isdigit())


def send_email(recipient, subject, body):
    host = os.environ.get("SMTP_HOST")
    sender = os.environ.get("SMTP_FROM") or os.environ.get("SMTP_USER")
    if not host or not sender:
        raise RuntimeError("Email OTP is not configured. Set SMTP_HOST and SMTP_FROM.")

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = sender
    message["To"] = recipient
    message.set_content(body)
    port = int(os.environ.get("SMTP_PORT", "587"))
    with smtplib.SMTP(host, port, timeout=15) as smtp:
        smtp.starttls()
        username = os.environ.get("SMTP_USER")
        password = os.environ.get("SMTP_PASSWORD")
        if username and password:
            smtp.login(username, password)
        smtp.send_message(message)


def send_sms(recipient, body):
    account_sid = os.environ.get("TWILIO_ACCOUNT_SID")
    auth_token = os.environ.get("TWILIO_AUTH_TOKEN")
    from_number = os.environ.get("TWILIO_FROM_NUMBER")
    if not account_sid or not auth_token or not from_number:
        raise RuntimeError(
            "Phone OTP is not configured. Set TWILIO_ACCOUNT_SID, "
            "TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER."
        )

    url = "https://api.twilio.com/2010-04-01/Accounts/{}/Messages.json".format(account_sid)
    data = urllib.parse.urlencode(
        {"To": recipient, "From": from_number, "Body": body}
    ).encode("utf-8")
    password_mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
    password_mgr.add_password(None, url, account_sid, auth_token)
    opener = urllib.request.build_opener(
        urllib.request.HTTPBasicAuthHandler(password_mgr)
    )
    request_obj = urllib.request.Request(url, data=data, method="POST")
    with opener.open(request_obj, timeout=15) as response:
        if response.status >= 400:
            raise RuntimeError("SMS provider rejected the OTP request.")


def empty_state():
    return {
        "parties": [],
        "vendors": [],
        "challans": [],
        "orders": [],
        "paperStock": {},
        "paperAdded": {},
        "paperSent": {},
        "paperMeta": {},
        "paperLocations": {},
        "stockFlow": [],
        "tallyRows": [],
        "activities": [],
    }


def decode_state_blob(raw_data):
    stored = json.loads(raw_data)
    if not isinstance(stored, dict):
        return {}, 0
    version = stored.pop(STATE_VERSION_KEY, 0)
    if not isinstance(version, int) or isinstance(version, bool) or version < 0:
        version = 0
    return stored, version


def encode_state_blob(data, version):
    stored = dict(data)
    stored[STATE_VERSION_KEY] = version
    return json.dumps(stored, separators=(",", ":"))


def accountant_state(data):
    orders = [
        {
            "id": order.get("id"),
            "name": order.get("name"),
            "partyName": order.get("partyName"),
            "qty": order.get("qty"),
            "stage": order.get("stage"),
            "dispatch": {
                key: value
                for key, value in (order.get("dispatch") or {}).items()
                if key in {"date", "rate", "status", "productImg", "biltyImg"}
            },
        }
        for order in data.get("orders", [])
        if order.get("stage") == "dispatch"
    ]
    return {
        **empty_state(),
        "vendors": json.loads(json.dumps(data.get("vendors", []))),
        "challans": json.loads(json.dumps(data.get("challans", []))),
        "orders": orders,
        "paperStock": data.get("paperStock", {}),
        "paperAdded": data.get("paperAdded", {}),
        "paperSent": data.get("paperSent", {}),
        "paperMeta": data.get("paperMeta", {}),
        "paperLocations": data.get("paperLocations", {}),
        "stockFlow": data.get("stockFlow", []),
        "tallyRows": data.get("tallyRows", []),
    }


def valid_attachment_data(value):
    if not isinstance(value, str) or not value:
        return isinstance(value, str)
    prefixes = (
        "data:image/jpeg;base64,",
        "data:image/png;base64,",
        "data:application/pdf;base64,",
    )
    return len(value) <= 2_800_000 and value.startswith(prefixes)


def update_accountant_state(existing, incoming):
    if not isinstance(incoming, dict):
        return False
    if set(incoming) != set(empty_state()):
        return False
    if (
        incoming.get("vendors") != existing.get("vendors", [])
        or incoming.get("challans") != existing.get("challans", [])
        or incoming.get("activities")
    ):
        return False

    previous_orders = {
        order["id"]: order for order in existing.get("orders", [])
        if order.get("stage") == "dispatch"
    }
    submitted_orders = incoming.get("orders", [])
    if (
        not isinstance(submitted_orders, list)
        or not all(isinstance(order, dict) for order in submitted_orders)
    ):
        return False
    submitted_ids = {order.get("id") for order in submitted_orders}
    if submitted_ids != set(previous_orders) or len(submitted_orders) != len(previous_orders):
        return False
    permitted_dispatch_fields = {"date", "rate", "status", "productImg", "biltyImg"}
    permitted_order_fields = {"id", "name", "partyName", "qty", "stage", "dispatch"}
    for submitted in submitted_orders:
        original = previous_orders.get(submitted.get("id"))
        dispatch = submitted.get("dispatch")
        if (
            original is None
            or set(submitted) != permitted_order_fields
            or not isinstance(dispatch, dict)
        ):
            return False
        if any(
            submitted.get(key) != original.get(key)
            for key in ("id", "name", "partyName", "qty", "stage")
        ):
            return False
        if set(dispatch) != permitted_dispatch_fields:
            return False
        rate = dispatch.get("rate")
        if (
            dispatch.get("status") not in {"Ready", "Dispatched", "Delivered"}
            or not isinstance(rate, (int, float))
            or isinstance(rate, bool)
            or not math.isfinite(rate)
            or rate < 0
            or not isinstance(dispatch.get("date"), str)
            or any(
                not valid_attachment_data(dispatch.get(key))
                for key in ("productImg", "biltyImg")
            )
        ):
            return False

    for key in ("paperStock", "paperAdded", "paperSent"):
        ledger = incoming.get(key)
        if not isinstance(ledger, dict) or any(
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(value)
            for value in ledger.values()
        ):
            return False
    paper_meta = incoming.get("paperMeta")
    paper_locations = incoming.get("paperLocations")
    if not isinstance(paper_meta, dict) or not isinstance(paper_locations, dict):
        return False
    for sku, locations in paper_locations.items():
        if (
            not isinstance(sku, str)
            or not isinstance(locations, dict)
            or any(
                location not in {"Printzone", "Darpan", "Gyan", "Kapil", "Other"}
                or not isinstance(quantity, (int, float))
                or isinstance(quantity, bool)
                or not math.isfinite(quantity)
                or quantity < 0
                for location, quantity in locations.items()
            )
        ):
            return False
    if any(
        not isinstance(sku, str)
        or not isinstance(meta, dict)
        or not isinstance(meta.get("paperType"), str)
        or not isinstance(meta.get("paperSize"), str)
        or not isinstance(meta.get("gsm"), (int, float))
        or isinstance(meta.get("gsm"), bool)
        or not math.isfinite(meta.get("gsm"))
        for sku, meta in paper_meta.items()
    ):
        return False
    if not isinstance(incoming.get("stockFlow"), list) or not isinstance(
        incoming.get("tallyRows"), list
    ):
        return False

    updated = json.loads(json.dumps(existing))
    incoming_by_id = {order["id"]: order for order in submitted_orders}
    for order in updated.get("orders", []):
        if order.get("id") in incoming_by_id:
            order["dispatch"].update(incoming_by_id[order["id"]]["dispatch"])
    for key in (
        "paperStock", "paperAdded", "paperSent", "paperMeta",
        "paperLocations", "stockFlow", "tallyRows",
    ):
        if key in incoming:
            updated[key] = incoming[key]
    return updated


def user_state(data):
    """Expose the operational sections available to a regular staff user."""
    visible = empty_state()
    for key in ("parties", "vendors", "challans", "activities"):
        visible[key] = data.get(key, visible[key])
    visible["orders"] = [
        {
            **order,
            "approvalStatus": order.get("approvalStatus", "Approved"),
            "prod": {
                "receivedFromVendor": False,
                "lamination": False,
                "laminationSkipped": False,
                "cutting": False,
                "pasting": False,
                "ready": False,
                **(order.get("prod") or {}),
            },
            "dispatch": {
                key: value
                for key, value in (order.get("dispatch") or {}).items()
                if key in {"date", "status"}
            },
        }
        for order in data.get("orders", [])
    ]
    return visible


def update_user_state(existing, incoming):
    if not isinstance(incoming, dict) or set(incoming) != set(empty_state()):
        return False
    if any((
        incoming.get("paperStock") != {},
        incoming.get("paperAdded") != {},
        incoming.get("paperSent") != {},
        incoming.get("paperMeta") != {},
        incoming.get("paperLocations") != {},
        incoming.get("stockFlow") != [],
        incoming.get("tallyRows") != [],
    )):
        return False
    for key in ("parties", "vendors", "challans", "orders", "activities"):
        if not isinstance(incoming.get(key), list):
            return False

    def retain_existing_records(key, id_key):
        if any(
            not isinstance(item, dict)
            or not isinstance(item.get(id_key), str)
            or not item[id_key]
            for item in incoming[key]
        ):
            return False
        submitted = {item[id_key]: item for item in incoming[key]}
        if len(submitted) != len(incoming[key]):
            return False
        previous = {
            item.get(id_key): item for item in existing.get(key, [])
            if isinstance(item, dict) and isinstance(item.get(id_key), str)
        }
        if key == "vendors" and not set(previous).issubset(submitted):
            return False
        if key == "parties" and any(
            submitted[item_id] != item
            for item_id, item in previous.items()
            if item_id in submitted
        ):
            return False
        if key == "vendors":
            for item_id, item in previous.items():
                candidate = submitted[item_id]
                old_sequence = item.get("challanSequence", 0)
                new_sequence = candidate.get("challanSequence", old_sequence)
                if (
                    {key: value for key, value in candidate.items() if key != "challanSequence"}
                    != {key: value for key, value in item.items() if key != "challanSequence"}
                    or not isinstance(new_sequence, int)
                    or isinstance(new_sequence, bool)
                    or new_sequence < old_sequence
                ):
                    return False
        return submitted, previous

    parties_result = retain_existing_records("parties", "id")
    vendors_result = retain_existing_records("vendors", "name")
    challans_result = retain_existing_records("challans", "id")
    orders_result = retain_existing_records("orders", "id")
    if any(result is False for result in (
        parties_result, vendors_result, challans_result, orders_result
    )):
        return False
    submitted_orders, previous_orders = orders_result
    submitted_challans, previous_challans = challans_result
    removed_parties = set(parties_result[1]) - set(parties_result[0])
    if any(
        order.get("partyId") in removed_parties
        for order in incoming["orders"]
        if isinstance(order, dict)
    ):
        return False
    removed_orders = set(previous_orders) - set(submitted_orders)
    if any(
        previous_orders[order_id].get("stage") == "dispatch"
        for order_id in removed_orders
    ):
        return False
    removed_challans = set(previous_challans) - set(submitted_challans)
    for challan_id in removed_challans:
        linked_orders = [
            order for order in existing.get("orders", [])
            if order.get("challanNo") == challan_id
        ]
        if any(
            order.get("stage") == "dispatch"
            or submitted_orders.get(order.get("id"), {}).get("challanNo")
            or submitted_orders.get(order.get("id"), {}).get("stage") != "pending"
            for order in linked_orders
        ):
            return False

    allowed_order_fields = {
        "id", "partyId", "partyName", "name", "qty", "size", "printingType",
        "jobType", "printingStatus", "challanNo", "vendor", "stage", "prod",
        "dispatch", "approvalStatus",
    }
    parties_by_id = {party["id"]: party for party in incoming["parties"]}
    permitted_party_ids = set(parties_by_id)
    updated = json.loads(json.dumps(existing))
    updated_orders = {
        order.get("id"): order for order in updated.get("orders", [])
        if isinstance(order, dict)
    }
    for challan_id in removed_challans:
        reversed_entries = [
            flow for flow in updated.get("stockFlow", [])
            if flow.get("challanNo") == challan_id
            and flow.get("type") in {"SENT", "TRANSFER"}
        ]
        for flow in reversed_entries:
            paper_type = flow.get("paperType")
            quantity = abs(int(flow.get("qty", 0)))
            sku = flow.get("sku") or paper_type
            if flow.get("sku") and flow.get("from") and flow.get("to"):
                locations = updated.setdefault("paperLocations", {}).setdefault(
                    sku, {}
                )
                locations[flow["from"]] = locations.get(flow["from"], 0) + quantity
                locations[flow["to"]] = max(
                    0, locations.get(flow["to"], 0) - quantity
                )
                updated.setdefault("paperStock", {})[sku] = locations.get(
                    "Printzone", 0
                )
            else:
                updated.setdefault("paperStock", {})[sku] = (
                    updated.get("paperStock", {}).get(sku, 0) + quantity
                )
            if not flow.get("from") or flow.get("from") == "Printzone":
                updated.setdefault("paperSent", {})[sku] = max(
                    0, updated.get("paperSent", {}).get(sku, 0) - quantity
                )
        updated["stockFlow"] = [
            flow for flow in updated.get("stockFlow", [])
            if not (
                flow.get("challanNo") == challan_id
                and flow.get("type") in {"SENT", "TRANSFER"}
            )
        ]
    for order_id, submitted in submitted_orders.items():
        if not isinstance(order_id, str) or not order_id:
            return False
        original = previous_orders.get(order_id)
        if set(submitted) not in {
            frozenset(allowed_order_fields),
            frozenset(allowed_order_fields - {"approvalStatus"}),
        } or not isinstance(submitted.get("dispatch"), dict):
            return False
        submitted.setdefault(
            "approvalStatus",
            original.get("approvalStatus", "Approved")
            if original is not None
            else "Pending Approval",
        )
        prod_keys = {
            "receivedFromVendor", "lamination", "cutting", "pasting", "ready"
        }
        extended_prod_keys = prod_keys | {"laminationSkipped"}
        if (
            submitted.get("stage") not in {"pending", "production", "dispatch"}
            or submitted.get("approvalStatus") not in {"Pending Approval", "Approved"}
            or submitted.get("printingStatus") not in {
                "Pending", "In Progress", "In Process", "Done"
            }
            or not isinstance(submitted.get("prod"), dict)
            or frozenset(submitted["prod"]) not in {
                frozenset(prod_keys), frozenset(extended_prod_keys)
            }
            or any(not isinstance(value, bool) for value in submitted["prod"].values())
            or not isinstance(submitted.get("challanNo"), str)
            or not isinstance(submitted.get("vendor"), str)
        ):
            return False
        if original is None:
            try:
                quantity = int(submitted.get("qty", 0))
            except (TypeError, ValueError):
                return False
            if (
                submitted.get("stage") != "pending"
                or submitted.get("approvalStatus") != "Pending Approval"
                or submitted.get("partyId") not in permitted_party_ids
                or submitted.get("partyName")
                != parties_by_id[submitted.get("partyId")].get("name")
                or not submitted.get("name")
                or quantity <= 0
                or submitted.get("challanNo")
                or submitted.get("vendor")
            ):
                return False
            new_order = json.loads(json.dumps(submitted))
            new_order["prod"].setdefault("laminationSkipped", False)
            new_order["dispatch"] = {
                "date": "",
                "rate": 0,
                "status": "Ready",
                "productImg": "",
                "biltyImg": "",
            }
            updated.setdefault("orders", []).append(new_order)
            updated_orders[order_id] = new_order
            continue
        previous_challan_id = original.get("challanNo") or ""
        submitted_challan_id = submitted.get("challanNo") or ""
        challans_by_id = {challan.get("id"): challan for challan in incoming["challans"]}
        removed_challan = bool(
            original.get("challanNo")
            and not submitted.get("challanNo")
            and submitted.get("stage") == "pending"
            and original.get("stage") != "dispatch"
            and original.get("vendor")
            and original.get("challanNo") not in challans_by_id
            and not submitted.get("vendor")
        )
        if submitted_challan_id != previous_challan_id:
            if submitted_challan_id:
                assigned_challan = challans_by_id.get(submitted_challan_id)
                if (
                    previous_challan_id
                    or not assigned_challan
                    or submitted.get("approvalStatus") != "Approved"
                    or submitted.get("printingStatus") != "Done"
                    or submitted.get("vendor", "").casefold()
                    != str((assigned_challan or {}).get("vendor", "")).casefold()
                    or submitted.get("stage") not in {"pending", "production"}
                ):
                    return False
            elif previous_challan_id and not removed_challan:
                return False
        immutable_fields = (
            "id", "partyId", "partyName", "name", "qty", "size",
            "printingType", "jobType",
        )
        editable_pending = (
            original.get("stage") == "pending"
            and (
                not original.get("challanNo")
                or not challans_by_id.get(original.get("challanNo"), {}).get(
                    "receivedFromVendor", False
                )
            )
        )
        if any(submitted.get(key) != original.get(key) for key in immutable_fields):
            if not editable_pending:
                return False
        previous_approval = original.get("approvalStatus", "Approved")
        if submitted.get("approvalStatus") != previous_approval:
            return False
        if previous_approval == "Pending Approval" and any(
            submitted.get(key) != original.get(key)
            for key in ("printingStatus", "challanNo", "vendor", "stage", "prod")
        ):
            return False
        if submitted.get("partyId"):
            party_ids = {party.get("id") for party in incoming["parties"] if isinstance(party, dict)}
            if submitted["partyId"] not in party_ids:
                return False
        if submitted.get("partyId") and submitted.get("partyName"):
            party = next(
                (party for party in incoming["parties"] if party.get("id") == submitted["partyId"]),
                None,
            )
            if party and submitted["partyName"] != party.get("name"):
                return False
        original_dispatch = {
            key: value
            for key, value in (original.get("dispatch") or {}).items()
            if key in {"date", "status"}
        }
        if submitted["dispatch"] != original_dispatch:
            return False
        previous_prod = {
            "receivedFromVendor": False,
            "lamination": False,
            "laminationSkipped": False,
            "cutting": False,
            "pasting": False,
            "ready": False,
            **(original.get("prod") or {}),
        }
        submitted_prod = {
            "receivedFromVendor": False,
            "lamination": False,
            "laminationSkipped": False,
            "cutting": False,
            "pasting": False,
            "ready": False,
            **submitted["prod"],
        }
        challan_received = challans_by_id.get(submitted.get("challanNo"), {}).get(
            "receivedFromVendor", False
        )
        if not removed_challan:
            if any(previous_prod[key] and not submitted_prod[key] for key in previous_prod):
                return False
            changed_steps = {
                key for key in previous_prod if not previous_prod[key] and submitted_prod[key]
            }
            if original.get("stage") == "pending" and submitted.get("stage") == "production":
                if (
                    not challan_received
                    or not submitted.get("challanNo")
                    or submitted.get("vendor") != challans_by_id.get(
                        submitted.get("challanNo"), {}
                    ).get("vendor")
                    or changed_steps != {"receivedFromVendor"}
                ):
                    return False
            elif original.get("stage") == "production":
                stage = (
                    "receivedFromVendor" if not previous_prod["receivedFromVendor"]
                    else "lamination" if not previous_prod["lamination"] and not previous_prod["laminationSkipped"]
                    else "cutting" if not previous_prod["cutting"]
                    else "pasting" if not previous_prod["pasting"]
                    else "ready" if not previous_prod["ready"]
                    else "complete"
                )
                allowed_changes = {
                    "receivedFromVendor": set(),
                    "lamination": {"lamination"},
                    "cutting": {"cutting"},
                    "pasting": {"pasting"},
                    "ready": {"ready"},
                    "complete": set(),
                }
                if stage == "lamination" and submitted_prod["laminationSkipped"]:
                    allowed_changes["lamination"] = {"laminationSkipped"}
                if changed_steps and changed_steps != allowed_changes[stage]:
                    return False
                if submitted.get("stage") == "dispatch" and (
                    not submitted_prod["ready"] or stage != "ready"
                ):
                    return False
                if submitted.get("stage") not in {"production", "dispatch"}:
                    return False
            elif submitted.get("stage") != original.get("stage") or changed_steps:
                return False
            if submitted_prod["lamination"] and submitted_prod["laminationSkipped"]:
                return False
            if submitted_prod["cutting"] and not submitted_prod["receivedFromVendor"]:
                return False
            if submitted_prod["pasting"] and not submitted_prod["cutting"]:
                return False
            if submitted_prod["ready"] and not submitted_prod["pasting"]:
                return False
            if submitted.get("stage") == "dispatch" and not submitted_prod["ready"]:
                return False
        else:
            submitted["stage"] = "pending"
        persisted_order = updated_orders[order_id]
        persisted_order.update({
            key: submitted[key]
            for key in (
                "printingStatus", "challanNo", "vendor", "stage", "prod",
                "approvalStatus",
            )
        })
        persisted_order["prod"] = submitted_prod

    updated["parties"] = incoming["parties"]
    updated["vendors"] = incoming["vendors"]
    updated["challans"] = incoming["challans"]
    updated["orders"] = [updated_orders[order["id"]] for order in incoming["orders"]]
    updated["activities"] = incoming["activities"][:10]
    return updated


@app.after_request
def set_security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("Cache-Control", "no-store")
    return response


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/track")
def track_order_page():
    user = current_user()
    if user is None or user["role"] != "Customer":
        return redirect("/")
    return render_template("customer_track.html")


@app.route("/api/auth/me", methods=["GET"])
def auth_me():
    user = current_user()
    return jsonify({"user": user})


@app.route("/api/auth/register", methods=["POST"])
def register():
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()
    username = str(payload.get("username", "")).strip()
    email = str(payload.get("email", "")).strip().lower()
    phone = normalized_phone(payload.get("phone"))
    password = str(payload.get("password", ""))
    if not name or len(name) > 120 or len(username) < 3 or len(username) > 40:
        return api_error("Enter your name and a username (3–40 characters).", 400)
    if "@" not in email or len(email) > 254:
        return api_error("Enter a valid email address.", 400)
    if len(phone) < 7 or len(phone) > 15:
        return api_error("Enter a valid phone number, including country code if needed.", 400)
    if len(password) < 8 or len(password) > 256:
        return api_error("Password must be at least 8 characters.", 400)

    try:
        with get_db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            first_user = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
            role = "Admin" if first_user else "Customer"
            conn.execute(
                """INSERT INTO users
                   (name, username, email, phone, password_hash, role, team_id, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    name,
                    username,
                    email,
                    phone,
                    generate_password_hash(password),
                    role,
                    "TEAM-ADMIN" if first_user else "TEAM-CUSTOMER",
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
    except sqlite3.IntegrityError:
        return api_error("That username, email, or phone number is already registered.", 409)

    session.clear()
    if role == "Customer":
        return jsonify({
            "message": "Customer account created. Sign in to continue.",
            "user": {
                "name": name,
                "username": username,
                "email": email,
                "phone": phone,
                "role": role,
                "team_id": "TEAM-CUSTOMER",
            }
        }), 201
    return jsonify({"message": "Account created. Sign in to continue."}), 201


@app.route("/api/auth/login", methods=["POST"])
def login():
    payload = request.get_json(silent=True) or {}
    identifier = str(payload.get("identifier", "")).strip()
    password = str(payload.get("password", ""))
    if not identifier or not password:
        return api_error("Enter your username, email, or phone and password.", 400)
    digits = normalized_phone(identifier)
    with get_db() as conn:
        user = conn.execute(
            """SELECT id, password_hash FROM users
               WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE OR phone = ?""",
            (identifier, identifier, digits),
        ).fetchone()
    if user is None or not check_password_hash(user["password_hash"], password):
        return api_error("The sign-in details are incorrect.", 401)
    session.clear()
    session["user_id"] = user["id"]
    return jsonify({"user": current_user()})


@app.route("/api/auth/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"status": "ok"})


@app.route("/api/auth/request-reset", methods=["POST"])
def request_password_reset():
    payload = request.get_json(silent=True) or {}
    identifier = str(payload.get("identifier", "")).strip()
    method = str(payload.get("method", "email")).lower()
    if not identifier or method not in {"email", "phone"}:
        return api_error("Provide your account email or phone number.", 400)

    with get_db() as conn:
        if method == "email":
            user = conn.execute(
                "SELECT id, email FROM users WHERE email = ? COLLATE NOCASE",
                (identifier,),
            ).fetchone()
        else:
            user = conn.execute(
                "SELECT id, phone FROM users WHERE phone = ?",
                (normalized_phone(identifier),),
            ).fetchone()
        if user is None:
            return jsonify({"message": "If that account exists, a reset code has been sent."})
        now = datetime.now(timezone.utc)
        previous = conn.execute(
            "SELECT requested_at FROM password_resets WHERE user_id = ?",
            (user["id"],),
        ).fetchone()
        if previous:
            last_requested = datetime.fromisoformat(previous["requested_at"])
            if (now - last_requested).total_seconds() < OTP_RESEND_SECONDS:
                return api_error("Please wait before requesting another code.", 429)
        code = "{:06d}".format(secrets.randbelow(1_000_000))
        conn.execute(
            """INSERT INTO password_resets (user_id, code_hash, expires_at, requested_at, attempts)
               VALUES (?, ?, ?, ?, 0)
               ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash,
                   expires_at = excluded.expires_at, requested_at = excluded.requested_at,
                   attempts = 0""",
            (
                user["id"],
                hashlib.sha256(code.encode("utf-8")).hexdigest(),
                (now + timedelta(minutes=OTP_TTL_MINUTES)).isoformat(),
                now.isoformat(),
            ),
        )
        destination = user["email"] if method == "email" else user["phone"]

    try:
        message = "Your Print Zone password reset code is {}. It expires in {} minutes.".format(
            code, OTP_TTL_MINUTES
        )
        if method == "email":
            send_email(destination, "Print Zone password reset", message)
        else:
            send_sms("+" + destination.lstrip("+"), message)
    except (OSError, RuntimeError, smtplib.SMTPException, urllib.error.URLError, ValueError):
        logging.exception("Could not deliver password reset code.")
        with get_db() as conn:
            conn.execute("DELETE FROM password_resets WHERE user_id = ?", (user["id"],))
        return api_error(
            "Could not send the reset code. Check the configured email or SMS service and try again.",
            503,
        )
    return jsonify({"message": "If that account exists, a reset code has been sent."})


@app.route("/api/auth/reset-password", methods=["POST"])
def reset_password():
    payload = request.get_json(silent=True) or {}
    identifier = str(payload.get("identifier", "")).strip()
    method = str(payload.get("method", "email")).lower()
    code = str(payload.get("code", "")).strip()
    password = str(payload.get("password", ""))
    if method not in {"email", "phone"} or not code.isdigit() or len(code) != 6:
        return api_error("Enter the six-digit code sent to your account.", 400)
    if len(password) < 8 or len(password) > 256:
        return api_error("New password must be at least 8 characters.", 400)

    with get_db() as conn:
        if method == "email":
            user = conn.execute(
                "SELECT id FROM users WHERE email = ? COLLATE NOCASE", (identifier,)
            ).fetchone()
        else:
            user = conn.execute(
                "SELECT id FROM users WHERE phone = ?", (normalized_phone(identifier),)
            ).fetchone()
        if user is None:
            return api_error("The code is invalid or expired.", 400)
        reset = conn.execute(
            "SELECT * FROM password_resets WHERE user_id = ?", (user["id"],)
        ).fetchone()
        if reset is None or reset["attempts"] >= 5:
            return api_error("The code is invalid or expired.", 400)
        if datetime.fromisoformat(reset["expires_at"]) <= datetime.now(timezone.utc):
            conn.execute("DELETE FROM password_resets WHERE user_id = ?", (user["id"],))
            return api_error("The code is invalid or expired.", 400)
        submitted_hash = hashlib.sha256(code.encode("utf-8")).hexdigest()
        if not secrets.compare_digest(submitted_hash, reset["code_hash"]):
            conn.execute(
                "UPDATE password_resets SET attempts = attempts + 1 WHERE user_id = ?",
                (user["id"],),
            )
            return api_error("The code is invalid or expired.", 400)
        conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (generate_password_hash(password), user["id"]),
        )
        conn.execute("DELETE FROM password_resets WHERE user_id = ?", (user["id"],))
    return jsonify({"message": "Password changed. You can now sign in."})


@app.route("/api/team", methods=["GET", "POST", "DELETE"])
def team_members():
    admin, error = require_user("Admin")
    if error:
        return error

    if request.method == "GET":
        with get_db() as conn:
            rows = conn.execute(
                """SELECT id, name, username, email, phone, role, team_id, created_at
                   FROM users WHERE role IN ('Admin', 'Manager', 'User', 'Accountant')
                     AND id != ?
                   ORDER BY name COLLATE NOCASE""",
                (admin["id"],),
            ).fetchall()
        return jsonify({"members": [dict(row) for row in rows]})

    if request.method == "POST":
        payload = request.get_json(silent=True) or {}
        name = str(payload.get("name", "")).strip()
        username = str(payload.get("username", "")).strip()
        email = str(payload.get("email", "")).strip().lower()
        phone = normalized_phone(payload.get("phone"))
        password = str(payload.get("password", ""))
        role = str(payload.get("role", ""))
        team_id = str(payload.get("team_id", "")).strip() or "TEAM-" + secrets.token_hex(3).upper()
        if role not in {"Admin", "Manager", "User", "Accountant"}:
            return api_error("Team members can be assigned Admin, Manager, User, or Accountant access.", 400)
        if not name or len(username) < 3 or "@" not in email or len(phone) < 7:
            return api_error("Enter a name, username, valid email, and phone number.", 400)
        if len(password) < 8:
            return api_error("Password must be at least 8 characters.", 400)
        try:
            with get_db() as conn:
                cursor = conn.execute(
                    """INSERT INTO users
                       (name, username, email, phone, password_hash, role, team_id, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        name, username, email, phone, generate_password_hash(password),
                        role, team_id, datetime.now(timezone.utc).isoformat(),
                    ),
                )
                member_id = cursor.lastrowid
                member = conn.execute(
                    """SELECT id, name, username, email, phone, role, team_id, created_at
                       FROM users WHERE id = ?""",
                    (member_id,),
                ).fetchone()
        except sqlite3.IntegrityError:
            return api_error("That username, email, or phone number is already registered.", 409)
        return jsonify({"member": dict(member)}), 201

    member_id = request.args.get("id", type=int)
    if not member_id:
        return api_error("Select a team member to remove.", 400)
    with get_db() as conn:
        cursor = conn.execute(
            """DELETE FROM users
               WHERE id = ? AND id != ? AND role IN ('Admin', 'Manager', 'User', 'Accountant')""",
            (member_id, admin["id"]),
        )
        conn.execute("DELETE FROM password_resets WHERE user_id = ?", (member_id,))
        if cursor.rowcount == 0:
            return api_error("Team member not found.", 404)
    return jsonify({"status": "deleted"})


@app.route("/api/state", methods=["GET", "POST"])
def state_api():
    user, error = require_user("Admin", "Manager", "User", "Accountant")
    if error:
        return error

    if request.method == "GET":
        with get_db() as conn:
            row = conn.execute(
                "SELECT data FROM app_state WHERE id = 1"
            ).fetchone()
        data, version = decode_state_blob(row["data"])
        if not data:
            return jsonify({
                "data": empty_state(),
                "initialized": False,
                "version": version,
            })
        if user["role"] == "Accountant":
            data = accountant_state(data)
        elif user["role"] == "User":
            data = user_state(data)
        return jsonify({
            "data": data,
            "initialized": True,
            "version": version,
        })

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return api_error("Invalid or oversized state data.", 400)
    if "version" not in payload or "data" not in payload:
        return api_error("Reload this page before saving workspace changes.", 428)
    expected_version = payload.get("version")
    incoming = payload.get("data")
    if (
        not isinstance(expected_version, int)
        or isinstance(expected_version, bool)
        or expected_version < 0
        or not isinstance(incoming, dict)
        or len(json.dumps(incoming)) > 7_000_000
    ):
        return api_error("Invalid or oversized state data.", 400)

    with get_db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT data FROM app_state WHERE id = 1"
        ).fetchone()
        existing, current_version = decode_state_blob(row["data"])
        if expected_version != current_version:
            remote = existing
            if user["role"] == "Accountant":
                remote = accountant_state(existing)
            elif user["role"] == "User":
                remote = user_state(existing)
            return jsonify({
                "error": "Workspace changed in another session.",
                "conflict": True,
                "data": remote,
                "version": current_version,
            }), 409
        if user["role"] == "Accountant":
            if not existing:
                return api_error("An administrator must initialize the workspace first.", 409)
            updated = update_accountant_state(existing, incoming)
            if updated is False:
                return api_error("This account cannot change data outside its assigned sections.", 403)
        elif user["role"] == "User":
            if not existing:
                return api_error("An administrator must initialize the workspace first.", 409)
            updated = update_user_state(existing, incoming)
            if updated is False:
                return api_error("This account cannot change data outside its assigned sections.", 403)
        else:
            updated = incoming
        new_version = current_version + 1
        conn.execute(
            "UPDATE app_state SET data = ? WHERE id = 1",
            (encode_state_blob(updated, new_version),),
        )
    return jsonify({
        "status": "ok",
        "updated": str(date.today()),
        "version": new_version,
    })


@app.route("/api/track", methods=["POST"])
def track_order():
    user, error = require_user("Customer")
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    order_id = str(payload.get("order_id", "")).strip().upper()
    phone = normalized_phone(payload.get("phone"))
    if not order_id or len(phone) < 7:
        return api_error("Enter your order ID and the phone number registered with the order.", 400)
    with get_db() as conn:
        row = conn.execute("SELECT data FROM app_state WHERE id = 1").fetchone()
    data = json.loads(row["data"])
    order = next(
        (item for item in data.get("orders", []) if str(item.get("id", "")).upper() == order_id),
        None,
    )
    party = next(
        (
            item for item in data.get("parties", [])
            if item.get("id") == (order or {}).get("partyId")
        ),
        None,
    )
    if (
        order is None
        or party is None
        or normalized_phone(party.get("mobile")) != phone
        or str(party.get("gmail", "")).strip().lower() != user["email"].lower()
    ):
        return api_error("We could not find an order matching those details.", 404)
    return jsonify({
        "order": {
            "id": order.get("id"),
            "name": order.get("name"),
            "quantity": order.get("qty"),
            "stage": order.get("stage"),
            "printing_status": order.get("printingStatus"),
            "dispatch_status": (order.get("dispatch") or {}).get("status"),
            "dispatch_date": (order.get("dispatch") or {}).get("date"),
        }
    })


@app.route("/api/customer/orders", methods=["GET"])
def customer_orders():
    user, error = require_user("Customer")
    if error:
        return error
    with get_db() as conn:
        row = conn.execute("SELECT data FROM app_state WHERE id = 1").fetchone()
    data = json.loads(row["data"])
    parties = {
        party.get("id"): party
        for party in data.get("parties", [])
        if str(party.get("gmail", "")).strip().lower() == user["email"].lower()
    }
    orders = [
        {
            "id": order.get("id"),
            "name": order.get("name"),
            "quantity": order.get("qty"),
            "stage": order.get("stage"),
            "printing_status": order.get("printingStatus"),
            "dispatch_status": (order.get("dispatch") or {}).get("status"),
            "dispatch_date": (order.get("dispatch") or {}).get("date"),
        }
        for order in data.get("orders", [])
        if order.get("partyId") in parties
    ]
    return jsonify({"orders": orders})


init_db()

if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG", "").lower() == "true", port=5000)
