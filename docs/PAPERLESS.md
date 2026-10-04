# Paperless-ngx attachment filing

Inbox Zero can send email attachments to a self-hosted Paperless-ngx instance.
Paperless consumes the original file and handles OCR, tags, correspondents, and
document types. Inbox Zero uses your filing preferences to decide which
attachments to save. Cloud drives remain the default destination.

## Connect a mailbox

1. In Paperless, create an API token in **My Profile**. The token's user needs
   permission to view/add documents and view tasks. A login cookie or OIDC token
   is not a Paperless API token.
2. In Inbox Zero, open **Attachments**, choose **Connect Paperless**, and enter
   the instance URL and API token. Include any hosting subpath, for example
   `https://paperless.example.com/archive`. The API must be reachable from the
   Inbox Zero server without an interactive proxy login or redirect.
3. Select **Paperless** as the filing destination. Connecting alone does not
   change where attachments are saved. Each mailbox has its own connection and
   destination; only one destination receives an attachment.
4. Set preferences such as “Save receipts and invoices; skip marketing material.”
   Preview processes recent attachments and uploads matching documents. Enable
   auto-filing when ready. The email reader's **Save to Paperless** button also
   works while auto-filing is paused and bypasses AI selection.

API tokens use the existing encrypted credential storage. Set and retain
`EMAIL_ENCRYPT_SECRET` and `EMAIL_ENCRYPT_SALT` as for other integrations.
Tokens are not returned to the browser after saving.

## Network and background processing

By default, the instance URL must use HTTPS and resolve to public addresses.
Requests refuse redirects and pin the validated DNS result for the connection.
For a trusted LAN deployment, set `PAPERLESS_ALLOW_PRIVATE_IPS=true` on the Inbox
Zero web service. This explicitly permits private addresses and HTTP for this
integration. The setting does not change webhook or MCP network policies.

Paperless uploads are asynchronous. Accepted uploads appear as **Processing in
Paperless** until the task returns a document ID, then as **Saved to Paperless**
with an **Open in Paperless** link. Duplicate tasks that identify the original
document link to that document. Completion notifications are sent after
consumption, according to mailbox preferences.

Compose, Helm, and Vercel include a once-per-minute call to
`GET /api/cron/paperless-filings`. Custom deployments must schedule that endpoint
with `Authorization: Bearer <CRON_SECRET>`. Keep `CRON_SECRET` configured on the
web service and scheduler. Without this job, uploads remain Processing in Inbox
Zero even if Paperless has finished them.

## Review and recovery

Uncertain AI selections ask for **Save** or **Skip**, in filing activity or by
replying to the confirmation email. Paperless handles organization; folder moves
are available only for cloud drives.

The task ID is persisted before marking a document saved. Webhook replays and
concurrent saves reuse the filing record instead of uploading again. A lost
upload response or interrupted request can leave an unknown outcome. Inbox Zero
does not automatically replay it: check Paperless and its task log before using
**Retry**. An accepted task still processing or already consumed is refreshed
rather than uploaded again. Disconnecting preserves filing history and pauses
Paperless auto-filing. Reconnect to resume task reconciliation.

If Paperless no longer reports an accepted task after 30 minutes, activity asks
you to check whether the document was saved before explicitly retrying. Keep
Paperless task retention long enough for the reconciliation job to see completed
tasks.

PDFs, supported images, text, and office documents can be submitted. Office and
OpenDocument files require Paperless's optional Tika/Gotenberg support; its
consumer remains the authority on file support. Archives are not submitted.

The integration is intended for Paperless-ngx v3 and accepts both paginated and
array task responses, with `related_document` or structured result document IDs.
Emulated HTTP tests verify the client contract; they do not replace checking a
specific Paperless installation's permissions and enabled consumers.
