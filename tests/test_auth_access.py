import json
import os
import tempfile
import unittest
from unittest.mock import patch

import app as printzone
from werkzeug.security import generate_password_hash


class AuthenticationAndAccessTests(unittest.TestCase):
    def setUp(self):
        self.previous_db_path = printzone.DB_PATH
        self.temp_dir = tempfile.TemporaryDirectory()
        printzone.DB_PATH = os.path.join(self.temp_dir.name, "test.db")
        printzone.app.config.update(TESTING=True)
        printzone.init_db()
        self.client = printzone.app.test_client()
        with printzone.get_db() as conn:
            conn.execute(
                """INSERT INTO users
                   (name, username, email, phone, password_hash, role, team_id, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    "Staff User", "staff", "staff@example.com", "15551234567",
                    generate_password_hash("password123"), "User", "TEAM-1", "2026-01-01",
                ),
            )
            conn.execute(
                "INSERT INTO users (name, username, email, phone, password_hash, role, team_id, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "Customer", "customer", "customer@example.com", "15557654321",
                    generate_password_hash("password123"), "Customer", "TEAM-CUSTOMER", "2026-01-01",
                ),
            )
            self.user_id = conn.execute(
                "SELECT id FROM users WHERE username = 'staff'"
            ).fetchone()["id"]
            self.customer_id = conn.execute(
                "SELECT id FROM users WHERE username = 'customer'"
            ).fetchone()["id"]
            conn.execute(
                "UPDATE app_state SET data = ? WHERE id = 1",
                (json.dumps(self.sample_state()),),
            )

    def tearDown(self):
        printzone.DB_PATH = self.previous_db_path
        self.temp_dir.cleanup()

    def save_state(self, data, version=None):
        if version is None:
            version = self.client.get("/api/state").json["version"]
        return self.client.post("/api/state", json={
            "version": version,
            "data": data,
        })

    @staticmethod
    def sample_state():
        return {
            **printzone.empty_state(),
            "parties": [
                {"id": "PTY-1", "name": "Customer Company", "mobile": "15557654321", "gmail": "customer@example.com"},
                {"id": "PTY-2", "name": "Other Company", "mobile": "15550000000", "gmail": "other@example.com"},
            ],
            "vendors": [{"name": "Vendor A", "role": "Printing", "prefix": "VEN"}],
            "orders": [
                {
                    "id": "ORD-001", "partyId": "PTY-1", "partyName": "Customer Company",
                    "name": "Box", "qty": 25, "size": "2x2", "printingType": "UV",
                    "jobType": "Box", "printingStatus": "In Process", "challanNo": "",
                    "vendor": "", "stage": "pending",
                    "prod": {"receivedFromVendor": False, "lamination": False, "cutting": False, "pasting": False, "ready": False},
                    "dispatch": {"date": "", "rate": 12, "status": "Ready", "productImg": "", "biltyImg": ""},
                },
                {
                    "id": "ORD-002", "partyId": "PTY-2", "partyName": "Other Company",
                    "name": "Label", "qty": 10, "size": "1x1", "printingType": "Matt",
                    "jobType": "Label", "printingStatus": "Done", "challanNo": "",
                    "vendor": "", "stage": "production",
                    "prod": {"receivedFromVendor": True, "lamination": False, "cutting": False, "pasting": False, "ready": False},
                    "dispatch": {"date": "", "rate": 99, "status": "Ready", "productImg": "private", "biltyImg": ""},
                },
            ],
            "paperStock": {"Private stock": 100},
            "paperAdded": {"Private stock": 100},
            "paperSent": {},
            "tallyRows": [{"party": "Private ledger"}],
        }

    def test_staff_login_succeeds_without_email_otp(self):
        with patch.object(printzone, "send_email") as send_email:
            response = self.client.post("/api/auth/login", json={
                "identifier": "staff",
                "password": "password123",
            })
        self.assertEqual(response.status_code, 200)
        send_email.assert_not_called()
        self.assertEqual(response.json["user"]["role"], "User")
        self.assertEqual(self.client.get("/api/auth/me").json["user"]["username"], "staff")
        self.assertEqual(
            self.client.post("/api/auth/verify-login-otp", json={}).status_code,
            404,
        )

    def test_admin_can_create_another_admin_with_team_access(self):
        with printzone.get_db() as conn:
            conn.execute("DELETE FROM users")

        registered = self.client.post("/api/auth/register", json={
            "name": "First Admin",
            "username": "firstadmin",
            "email": "firstadmin@example.com",
            "phone": "15551112222",
            "password": "password123",
        })
        self.assertEqual(registered.status_code, 201)
        signed_in = self.client.post("/api/auth/login", json={
            "identifier": "firstadmin",
            "password": "password123",
        })
        self.assertEqual(signed_in.status_code, 200)
        self.assertEqual(signed_in.json["user"]["role"], "Admin")

        created = self.client.post("/api/team", json={
            "name": "Second Admin",
            "username": "secondadmin",
            "email": "secondadmin@example.com",
            "phone": "15553334444",
            "password": "password123",
            "team_id": "TEAM-2",
            "role": "Admin",
        })
        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.json["member"]["role"], "Admin")
        listed = self.client.get("/api/team")
        self.assertEqual(listed.status_code, 200)
        self.assertEqual([member["username"] for member in listed.json["members"]], ["secondadmin"])

        second_admin_login = self.client.post("/api/auth/login", json={
            "identifier": "secondadmin",
            "password": "password123",
        })
        self.assertEqual(second_admin_login.json["user"]["role"], "Admin")
        self.assertEqual(self.client.get("/api/team").status_code, 200)

    def test_login_page_omits_sign_in_otp_and_loads_premium_icon(self):
        page = self.client.get("/")
        self.assertEqual(page.status_code, 200)
        self.assertNotIn(b"loginOtpForm", page.data)
        self.assertNotIn(b"resetDemoBtn", page.data)
        self.assertNotIn(b"Reset Sample Data", page.data)
        self.assertIn(b"Darpan", page.data)
        self.assertNotIn(b"ORD-004", page.data)
        self.assertIn(b'challanEligibleJobs', page.data)
        self.assertIn(b'data-job-filter="awaiting-challan"', page.data)
        self.assertIn(b'id="challanPartyFilter"', page.data)
        self.assertIn(b'id="vendorPartyFilter"', page.data)
        self.assertIn(b'Update Status', page.data)
        self.assertIn(b'toggleSidebarCollapsed', page.data)
        self.assertNotIn(b'nav-rail-btn', page.data)
        self.assertIn(b"/static/img/favicon.svg", page.data)
        icon = self.client.get("/static/img/favicon.svg")
        self.assertEqual(icon.status_code, 200)
        icon.close()

        script = self.client.get("/static/js/app.js")
        self.assertIn(b"parties: []", script.data)
        self.assertNotIn(b"Apex Pharma", script.data)
        self.assertNotIn(b"printzone_erp_v4", script.data)
        script.close()

    def test_user_api_hides_and_preserves_financial_data(self):
        with self.client.session_transaction() as session:
            session["user_id"] = self.user_id

        response = self.client.get("/api/state")
        self.assertEqual(response.status_code, 200)
        visible = response.json["data"]
        self.assertEqual(visible["paperStock"], {})
        self.assertEqual(visible["tallyRows"], [])
        self.assertNotIn("rate", visible["orders"][0]["dispatch"])
        tampered = json.loads(json.dumps(visible))
        tampered["orders"][0]["dispatch"]["rate"] = 0
        self.assertEqual(self.save_state(tampered).status_code, 403)
        visible["paperStock"] = {"Private stock": 0}
        denied = self.save_state(visible)
        self.assertEqual(denied.status_code, 403)

        visible["paperStock"] = {}
        visible["orders"][0]["printingStatus"] = "Done"
        saved = self.save_state(visible)
        self.assertEqual(saved.status_code, 200)
        with printzone.get_db() as conn:
            persisted = json.loads(conn.execute(
                "SELECT data FROM app_state WHERE id = 1"
            ).fetchone()["data"])
        self.assertEqual(persisted["orders"][0]["dispatch"]["rate"], 12)
        self.assertEqual(persisted["paperStock"]["Private stock"], 100)
        self.assertEqual(self.client.get("/api/team").status_code, 403)

        updated_state = self.client.get("/api/state").json["data"]
        updated_state["parties"].append({
            "id": "PTY-3", "name": "New Company", "mobile": "15559990000",
            "gmail": "new@example.com",
        })
        updated_state["orders"].append({
            "id": "ORD-003", "partyId": "PTY-3", "partyName": "New Company",
            "name": "New Carton", "qty": 50, "size": "3x2", "printingType": "UV",
            "jobType": "Box", "printingStatus": "In Process", "challanNo": "",
            "vendor": "", "stage": "pending",
            "prod": {"receivedFromVendor": False, "lamination": False, "cutting": False, "pasting": False, "ready": False},
            "dispatch": {"date": "", "rate": 0, "status": "Ready", "productImg": "", "biltyImg": ""},
        })
        created = self.save_state(updated_state)
        self.assertEqual(created.status_code, 200)
        with printzone.get_db() as conn:
            persisted = json.loads(conn.execute(
                "SELECT data FROM app_state WHERE id = 1"
            ).fetchone()["data"])
        self.assertEqual(persisted["orders"][-1]["id"], "ORD-003")

    def test_user_can_delete_order_and_unlinked_party_through_api(self):
        with self.client.session_transaction() as session:
            session["user_id"] = self.user_id

        data = self.client.get("/api/state").json["data"]
        data["orders"] = [order for order in data["orders"] if order["id"] != "ORD-001"]
        self.assertEqual(self.save_state(data).status_code, 200)

        data = self.client.get("/api/state").json["data"]
        data["parties"] = [party for party in data["parties"] if party["id"] != "PTY-1"]
        self.assertEqual(self.save_state(data).status_code, 200)
        self.assertEqual(
            [party["id"] for party in self.client.get("/api/state").json["data"]["parties"]],
            ["PTY-2"],
        )

    def test_user_cannot_delete_dispatched_order_through_api(self):
        with self.client.session_transaction() as session:
            session["user_id"] = self.user_id
        existing = self.sample_state()
        existing["orders"][0]["stage"] = "dispatch"
        existing["orders"][0]["prod"]["ready"] = True
        with printzone.get_db() as conn:
            conn.execute("UPDATE app_state SET data = ? WHERE id = 1", (json.dumps(existing),))

        data = self.client.get("/api/state").json["data"]
        data["orders"] = [order for order in data["orders"] if order["id"] != "ORD-001"]
        self.assertEqual(self.save_state(data).status_code, 403)

    def test_state_api_rejects_stale_saves_without_overwriting_newer_data(self):
        with self.client.session_transaction() as session:
            session["user_id"] = self.user_id

        initial = self.client.get("/api/state").json
        stale_state = json.loads(json.dumps(initial["data"]))
        current_state = json.loads(json.dumps(initial["data"]))
        current_state["orders"][0]["printingStatus"] = "In Progress"
        saved = self.save_state(current_state, initial["version"])
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json["version"], initial["version"] + 1)

        stale_state["orders"][0]["printingStatus"] = "Done"
        conflict = self.save_state(stale_state, initial["version"])
        self.assertEqual(conflict.status_code, 409)
        self.assertTrue(conflict.json["conflict"])
        self.assertEqual(conflict.json["version"], saved.json["version"])
        self.assertEqual(
            conflict.json["data"]["orders"][0]["printingStatus"],
            "In Progress",
        )
        persisted = self.client.get("/api/state").json
        self.assertEqual(persisted["data"]["orders"][0]["printingStatus"], "In Progress")

    def test_state_api_requires_a_revision_for_workspace_writes(self):
        with self.client.session_transaction() as session:
            session["user_id"] = self.user_id

        response = self.client.post("/api/state", json=self.client.get("/api/state").json["data"])

        self.assertEqual(response.status_code, 428)

    def test_customer_only_receives_orders_for_registered_email(self):
        with self.client.session_transaction() as session:
            session["user_id"] = self.customer_id

        response = self.client.get("/api/customer/orders")
        self.assertEqual(response.status_code, 200)
        self.assertEqual([order["id"] for order in response.json["orders"]], ["ORD-001"])
        self.assertNotIn("rate", response.json["orders"][0])

    def test_staff_cannot_skip_lamination_before_cutting(self):
        existing = self.sample_state()
        incoming = printzone.user_state(existing)
        order = next(item for item in incoming["orders"] if item["id"] == "ORD-002")

        order["prod"]["cutting"] = True
        self.assertFalse(printzone.update_user_state(existing, incoming))

        order["prod"]["cutting"] = False
        order["prod"]["laminationSkipped"] = True
        updated = printzone.update_user_state(existing, incoming)
        self.assertIsNot(updated, False)

        next_input = printzone.user_state(updated)
        next_order = next(item for item in next_input["orders"] if item["id"] == "ORD-002")
        next_order["prod"]["cutting"] = True
        self.assertIsNot(printzone.update_user_state(updated, next_input), False)

    def test_staff_can_delete_order_then_unlinked_party(self):
        existing = self.sample_state()
        incoming = printzone.user_state(existing)
        incoming["orders"] = [
            order for order in incoming["orders"] if order["id"] != "ORD-001"
        ]

        updated = printzone.update_user_state(existing, incoming)
        self.assertIsNot(updated, False)
        self.assertEqual([order["id"] for order in updated["orders"]], ["ORD-002"])

        incoming = printzone.user_state(updated)
        incoming["parties"] = [
            party for party in incoming["parties"] if party["id"] != "PTY-1"
        ]
        updated = printzone.update_user_state(updated, incoming)
        self.assertIsNot(updated, False)
        self.assertEqual([party["id"] for party in updated["parties"]], ["PTY-2"])

    def test_staff_cannot_delete_dispatched_order(self):
        existing = self.sample_state()
        existing["orders"][0]["stage"] = "dispatch"
        existing["orders"][0]["prod"]["ready"] = True
        incoming = printzone.user_state(existing)
        incoming["orders"] = [
            order for order in incoming["orders"] if order["id"] != "ORD-001"
        ]

        self.assertFalse(printzone.update_user_state(existing, incoming))

    def test_staff_cannot_approve_an_order(self):
        existing = self.sample_state()
        existing["orders"][0]["approvalStatus"] = "Pending Approval"
        incoming = printzone.user_state(existing)
        incoming["orders"][0]["approvalStatus"] = "Approved"

        self.assertFalse(printzone.update_user_state(existing, incoming))

    def test_new_user_order_defaults_to_pending_approval(self):
        existing = self.sample_state()
        incoming = printzone.user_state(existing)
        incoming["orders"].append({
            "id": "ORD-003", "partyId": "PTY-1", "partyName": "Customer Company",
            "name": "New Box", "qty": 8, "size": "2x2", "printingType": "UV",
            "jobType": "Box", "printingStatus": "Pending", "challanNo": "",
            "vendor": "", "stage": "pending", "prod": {
                "receivedFromVendor": False, "lamination": False,
                "laminationSkipped": False, "cutting": False,
                "pasting": False, "ready": False,
            }, "dispatch": {"date": "", "status": "Ready"},
        })

        updated = printzone.update_user_state(existing, incoming)

        self.assertIsNot(updated, False)
        self.assertEqual(updated["orders"][-1]["approvalStatus"], "Pending Approval")

    def test_staff_can_assign_multiple_completed_jobs_to_one_challan(self):
        existing = self.sample_state()
        second_job = json.loads(json.dumps(existing["orders"][0]))
        second_job.update({"id": "ORD-003", "name": "Second Box"})
        existing["orders"].append(second_job)
        incoming = printzone.user_state(existing)
        incoming["challans"].append({
            "id": "CH-2026-0001",
            "vendor": "Vendor A",
            "receivedFromVendor": False,
            "status": "Created (Vendor A)",
            "history": ["Created for Vendor A"],
        })
        for order in incoming["orders"]:
            if order["id"] in {"ORD-001", "ORD-003"}:
                order["printingStatus"] = "Done"
                order["challanNo"] = "CH-2026-0001"
                order["vendor"] = "Vendor A"

        updated = printzone.update_user_state(existing, incoming)

        self.assertIsNot(updated, False)
        assigned = [order for order in updated["orders"] if order["challanNo"]]
        self.assertEqual([order["id"] for order in assigned], ["ORD-001", "ORD-003"])
        self.assertTrue(all(order["stage"] == "pending" for order in assigned))

    def test_staff_cannot_assign_incomplete_job_or_change_vendor(self):
        existing = self.sample_state()
        incoming = printzone.user_state(existing)
        incoming["challans"].append({
            "id": "CH-2026-0001",
            "vendor": "Vendor A",
            "receivedFromVendor": False,
            "status": "Created (Vendor A)",
            "history": [],
        })
        order = next(item for item in incoming["orders"] if item["id"] == "ORD-001")
        order.update({"challanNo": "CH-2026-0001", "vendor": "Vendor A"})
        self.assertFalse(printzone.update_user_state(existing, incoming))

        order["printingStatus"] = "Done"
        order["vendor"] = "Vendor B"
        self.assertFalse(printzone.update_user_state(existing, incoming))

    def test_deleting_challan_resets_linked_job_and_returns_stock(self):
        existing = self.sample_state()
        existing["challans"] = [{
            "id": "PZ-VEN-001", "vendor": "Vendor A", "paperQty": 25,
            "paperType": "300 GSM Art Card", "receivedFromVendor": False,
        }]
        existing["orders"][0].update({
            "challanNo": "PZ-VEN-001", "vendor": "Vendor A", "printingStatus": "Done",
        })
        existing["paperStock"]["300 GSM Art Card"] = 75
        existing["paperSent"]["300 GSM Art Card"] = 25
        existing["stockFlow"] = [{
            "type": "SENT", "paperType": "300 GSM Art Card", "qty": -25,
            "note": "Vendor A", "challanNo": "PZ-VEN-001", "balanceAfter": 75,
        }]
        incoming = printzone.user_state(existing)
        incoming["challans"] = []
        job = next(item for item in incoming["orders"] if item["id"] == "ORD-001")
        job.update({
            "challanNo": "", "vendor": "", "printingStatus": "In Process",
            "stage": "pending",
            "prod": {
                "receivedFromVendor": False, "lamination": False,
                "laminationSkipped": False, "cutting": False,
                "pasting": False, "ready": False,
            },
        })

        updated = printzone.update_user_state(existing, incoming)
        self.assertIsNot(updated, False)
        self.assertEqual(updated["orders"][0]["stage"], "pending")
        self.assertEqual(updated["orders"][0]["challanNo"], "")
        self.assertEqual(updated["paperStock"]["300 GSM Art Card"], 100)
        self.assertEqual(updated["paperSent"]["300 GSM Art Card"], 0)
        self.assertEqual(updated["stockFlow"], [])

    def test_deleting_challan_reverses_tracked_vendor_transfers(self):
        existing = self.sample_state()
        sku = "Art Card | 23x36 | 300"
        existing["challans"] = [{
            "id": "CH-2026-0001", "vendor": "Gyan Digital",
            "paperType": "Art Card", "paperSize": "23x36", "gsm": 300,
            "paperQty": 20, "receivedFromVendor": False,
        }]
        existing["orders"][0].update({
            "challanNo": "CH-2026-0001", "vendor": "Gyan Digital",
            "printingStatus": "Done",
        })
        existing["paperStock"][sku] = 0
        existing["paperSent"][sku] = 20
        existing["paperMeta"][sku] = {
            "paperType": "Art Card", "paperSize": "23x36", "gsm": 300,
        }
        existing["paperLocations"][sku] = {
            "Printzone": 0, "Darpan": 0, "Gyan": 0, "Kapil": 0, "Other": 0,
        }
        existing["stockFlow"] = [
            {
                "type": "TRANSFER", "sku": sku, "paperType": "Art Card",
                "qty": -20, "from": "Gyan", "to": "Darpan",
                "challanNo": "CH-2026-0001",
            },
            {
                "type": "SENT", "sku": sku, "paperType": "Art Card",
                "qty": -20, "from": "Printzone", "to": "Gyan",
                "challanNo": "CH-2026-0001",
            },
        ]
        incoming = printzone.user_state(existing)
        incoming["challans"] = []
        incoming["orders"][0].update({
            "challanNo": "", "vendor": "", "printingStatus": "In Process",
            "stage": "pending",
        })

        updated = printzone.update_user_state(existing, incoming)

        self.assertIsNot(updated, False)
        self.assertEqual(updated["paperLocations"][sku]["Printzone"], 20)
        self.assertEqual(updated["paperLocations"][sku]["Gyan"], 0)
        self.assertEqual(updated["paperLocations"][sku]["Darpan"], 0)
        self.assertEqual(updated["paperSent"][sku], 0)
        self.assertEqual(updated["stockFlow"], [])

    def test_accountant_can_save_pdf_builty_attachment(self):
        existing = self.sample_state()
        existing["orders"][0]["stage"] = "dispatch"
        incoming = printzone.accountant_state(existing)
        incoming["orders"][0]["dispatch"]["biltyImg"] = "data:application/pdf;base64,JVBERi0="

        updated = printzone.update_accountant_state(existing, incoming)
        self.assertIsNot(updated, False)
        self.assertEqual(
            updated["orders"][0]["dispatch"]["biltyImg"],
            "data:application/pdf;base64,JVBERi0=",
        )

        incoming["orders"][0]["dispatch"]["biltyImg"] = "data:text/html;base64,PGgxPg=="
        self.assertFalse(printzone.update_accountant_state(existing, incoming))

    def test_accountant_can_update_nonnegative_paper_location_balances(self):
        existing = self.sample_state()
        incoming = printzone.accountant_state(existing)
        sku = "Art Card | 23x36 | 300"
        incoming["paperMeta"][sku] = {
            "paperType": "Art Card", "paperSize": "23x36", "gsm": 300,
        }
        incoming["paperStock"][sku] = 50
        incoming["paperLocations"][sku] = {
            "Printzone": 50, "Darpan": 0, "Gyan": 0, "Kapil": 0, "Other": 0,
        }

        updated = printzone.update_accountant_state(existing, incoming)

        self.assertIsNot(updated, False)
        self.assertEqual(updated["paperLocations"][sku]["Printzone"], 50)

        incoming["paperLocations"][sku]["Printzone"] = -1
        self.assertFalse(printzone.update_accountant_state(existing, incoming))

    def test_accountant_can_save_stock_with_readonly_vendor_and_challan_lists(self):
        existing = self.sample_state()
        existing["challans"] = [{
            "id": "CH-2026-0001",
            "vendor": "Vendor A",
            "paperType": "Art Card",
            "paperSize": "23x36",
            "gsm": 300,
            "paperQty": 20,
            "receivedFromVendor": False,
        }]
        incoming = printzone.accountant_state(existing)
        incoming["paperStock"]["Art Card | 23x36 | 300"] = 50

        updated = printzone.update_accountant_state(existing, incoming)

        self.assertIsNot(updated, False)
        self.assertEqual(updated["paperStock"]["Art Card | 23x36 | 300"], 50)
        incoming["challans"][0]["vendor"] = "Changed Vendor"
        self.assertFalse(printzone.update_accountant_state(existing, incoming))


if __name__ == "__main__":
    unittest.main()
