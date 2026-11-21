# PRINT ZONE — Flask + SQLite ERP

## Run locally

```bash
pip install -r requirements.txt
python app.py
```

Open `http://127.0.0.1:5000`. The first account created is the workspace administrator. Later public registrations are customer accounts; an administrator can create staff and additional administrator accounts from **Team Access**. Sign in with your username, email, or phone and password. Verification codes are used only for password resets.

## Roles

- **Admin:** all workspace sections; can add and remove Admin/Manager/User/Accountant team members.
- **Manager:** all workspace sections; cannot manage team members.
- **User:** can manage orders, parties, challans, vendors, and production; cannot access dispatch, accounting, stock, or team management.
- **Accountant:** Dispatch, Accountant, and Paper Stock only. These permissions are checked by the server as well as the interface.
- **Customer:** can sign in at `/track` and view order status for parties using the same registered email address. Customers cannot access the internal workspace.

Workspace data is stored in SQLite and is available to signed-in staff. New workspaces start empty; legacy browser data is not imported.

The workspace checks for teammate updates every three seconds while a page is open. Changes are saved with a database revision so simultaneous edits do not silently overwrite one another. Independent record edits are merged; if users change the same record or paper stock concurrently, the page asks the user to load the latest version before continuing.

## Jobs and challans

New orders enter **Pending Approval**; an Admin or Manager's final approval moves them into **Pending Order**. Pending Jobs separates active work, design in progress, design-completed work, jobs awaiting a challan, and jobs already assigned. Design completion does not start Production. Create a challan with the automatically generated year-based ID (`CH-YYYY-0001`) and select multiple eligible completed jobs for the same vendor; existing vendor-coded challan IDs remain unchanged. A job can only be assigned to one challan at a time. Use the challan details to review all linked jobs and the Print / Save PDF action to print or save a copy.

Marking a challan received moves its linked jobs into Production. Challan and Paper Stock workflows track paper by type, size, GSM, and location, including transfers to vendors and receipts back to Printzone. Vendor challan lists show printed and received status. Challans and vendor ledgers can be filtered by party and vendor. Orders can be deleted; parties can be deleted after their orders are removed. Production advances in order: optional lamination (complete or skip), cutting, pasting, then Ready.

Attach a Builty receipt to an order in Dispatch. JPG, PNG, and PDF files up to 2 MB are supported; the receipt can be previewed or opened/downloaded from the order record.

## Email delivery for password-reset codes

Password-reset codes expire after 10 minutes, are limited to five attempts, and can be requested once per minute. Configure a Gmail account to send email reset codes:

### Gmail SMTP

Enable 2-Step Verification on the sending Gmail account and create a Google App Password. Set these environment variables (do not use your normal Gmail password):

- `SMTP_HOST=smtp.gmail.com`
- `SMTP_PORT=587`
- `SMTP_FROM` and `SMTP_USER` to the sending Gmail address
- `SMTP_PASSWORD` to the Google App Password

SMTP uses STARTTLS. SMS-based password reset remains available if Twilio is configured:

### SMS reset via Twilio

Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`. Enter account phone numbers with their country code for SMS delivery.

Set a stable, private `SECRET_KEY` for deployments so sessions remain valid across restarts. Set `COOKIE_SECURE=true` when serving the site over HTTPS. Never commit these values to source control.
