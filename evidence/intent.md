# Secure Document Request Portal

## Overview

The portal replaces email as the channel for collecting customer documents. Bankers raise a request, customers upload through a single-use link protected by a one-time code, and every access is logged and retention is enforced.

Today bankers email customers for payslips, bank statements and ID, and customers reply with attachments. This creates three problems:

- **Privacy:** sensitive documents sit in inboxes indefinitely, accessible to anyone with mailbox access and outside retention controls (Privacy Act, APRA CPS 234).
- **Fraud:** customers learn to send documents in reply to emails, the exact behaviour phishing exploits.
- **Audit:** there is no reliable record of who requested a document, who viewed it, or when it was destroyed.

**Outcome:** documents reach only authorised staff through a controlled channel, with a complete audit trail and automatic deletion at end of retention.

## Goals & non-goals

### Goals

- Remove email as a channel for receiving customer documents.
- Ensure only the requesting banker and authorised compliance staff can access a document.
- Make a stolen link alone insufficient to upload or view anything.
- Provide a complete, tamper-evident audit trail for every request and document.
- Delete documents automatically at the end of their retention period.

### Non-goals

- Document verification or OCR (checking a payslip is genuine).
- Customer-initiated uploads without a banker request.
- Replacing the bank's records management or core banking systems.

## Users and personas

| Persona                | Needs                                                  | Access                                                                   |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| Banker (requester)     | Request documents quickly, see status, reissue a link  | Create requests; view documents on their own requests                    |
| Customer               | Upload easily from a phone without creating an account | Upload only, through a verified link; cannot view documents after upload |
| Compliance officer     | Review documents and the full audit trail              | View all documents and audit events; cannot create requests              |
| Other banker           | None for this request                                  | No access; attempts are blocked and logged                               |
| System (retention job) | Delete expired documents                               | Delete files; writes audit events                                        |

## User journeys

### Main journey: request to upload to review

1. The banker selects a customer and the document types needed (for example, two recent payslips and photo ID).
2. The system creates the request and a single-use upload link, shown once to the banker.
3. The customer opens the link and the system sends a one-time code to the mobile number already held on the customer's record.
4. The customer enters the code and gets a short-lived upload session.
5. The customer uploads the documents; each file is validated and stored.
6. The request moves to Received and the banker is notified.
7. The banker or a compliance officer views the documents; every view and download is logged.
8. At the end of the retention period, the documents are deleted and the deletion is logged.

### Alternate journeys

- **Link expired or lost:** the banker reissues a link; the old link is revoked immediately.
- **Wrong code entered 5 times:** the link is locked, a suspicious-activity event is logged, and the banker must reissue.
- **Invalid file:** the upload is rejected with a clear reason (type or size) and the customer can retry.
- **Wrong person tries to view:** access is denied and the attempt is logged.
- **Request cancelled:** the banker cancels; any active link is revoked and uploaded files follow the retention rule.

## Functional requirements

| ID    | Requirement                                                                                                     | Priority |
| ----- | --------------------------------------------------------------------------------------------------------------- | -------- |
| FR-1  | A banker can create a request for a customer, selecting one or more document types.                             | Must     |
| FR-2  | The system generates a random single-use upload token and shows the link to the banker once.                    | Must     |
| FR-3  | The link expires 72 hours after issue, or immediately after a successful upload session ends (files submitted). | Must     |
| FR-4  | A banker can reissue a link; issuing a new link revokes the previous one.                                       | Must     |
| FR-5  | Opening a valid link triggers a 6-digit one-time code sent to the mobile number on the customer record.         | Must     |
| FR-6  | The code expires after 5 minutes; 5 wrong attempts lock the link.                                               | Must     |
| FR-7  | Code resends are rate-limited (for example, 3 per link).                                                        | Should   |
| FR-8  | A verified customer can upload PDF, JPG or PNG files up to 10 MB each.                                          | Must     |
| FR-9  | File type is checked by content (magic bytes), not only by extension.                                           | Must     |
| FR-10 | Each stored file gets a random internal name, a SHA-256 hash and a retention date.                              | Must     |
| FR-11 | Request status moves through Open, Received, Closed, Cancelled or Expired.                                      | Must     |
| FR-12 | The requesting banker and compliance officers can view and download documents; no one else can.                 | Must     |
| FR-13 | Every action writes an audit event: actor, action, target, time, source IP and outcome.                         | Must     |
| FR-14 | Compliance officers can view the audit trail for any request.                                                   | Must     |
| FR-15 | A scheduled job deletes documents past their retention date and logs each deletion.                             | Must     |
| FR-16 | The banker is notified when a customer completes an upload.                                                     | Should   |
| FR-17 | Uploaded files pass through a malware-scanning hook before becoming viewable.                                   | Should   |

## Security and compliance requirements

The design uses layered controls: hashing protects secrets at rest, TLS protects data in transit, and the one-time code protects against the link itself being compromised.

**Threat model**

| Threat                                               | Control                                                                                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Database leak exposes live upload links              | Tokens and one-time codes are stored only as SHA-256 hashes; raw tokens are never retrievable.                               |
| Network interception (man-in-the-middle)             | TLS everywhere, HSTS, no plain-HTTP endpoints.                                                                               |
| Link intercepted via compromised email or forwarding | One-time code sent to a separate channel already on file; never to the channel that carried the link.                        |
| Brute-forcing tokens or codes                        | Long random tokens; code lockout after 5 attempts; rate limiting on link and code endpoints.                                 |
| Token leaked via browser referrer or logs            | `Referrer-Policy: no-referrer`; tokens masked in application logs.                                                           |
| Malicious file upload                                | Allow-list of types checked by content; size limit; malware-scan hook; files stored outside the web root and never executed. |
| Insider viewing documents without a need             | Role-based access scoped to the requesting banker and compliance; every view logged.                                         |
| Audit log tampering                                  | Append-only log; each event carries the hash of the previous one so gaps or edits are detectable.                            |
| Data kept longer than needed                         | Retention date on every file; automatic, logged deletion.                                                                    |

## Non-functional requirements

- **Usability:** the customer flow works on a mobile browser with no account or app install, in three steps or fewer (open link, enter code, upload).
- **Accessibility:** customer pages meet WCAG 2.1 AA.
- **Auditability:** audit events are immutable and queryable by request, actor and date.
- **Data residency:** documents and audit data are stored in Australia.
- **Retention:** default retention period is configurable per document type.
- **Availability:** the customer upload flow targets 99.9% during business hours.
- **Observability:** failed logins, lockouts and denied access attempts raise alerts for security monitoring.
- **Portability:** storage, messaging and identity sit behind interfaces so providers can be swapped without changing business logic.

## Acceptance criteria

- [ ] A banker creates a request and sees the upload link exactly once.
- [ ] A valid link plus the correct code lets the customer upload a PDF.
- [ ] A renamed executable with a .pdf extension is rejected.
- [ ] A file over 10 MB is rejected.
- [ ] A used, expired or reissued (revoked) link is refused.
- [ ] Five wrong codes lock the link and log a suspicious-activity event.
- [ ] Another banker gets access denied, and the attempt is logged.
- [ ] Compliance can view the document and the full audit trail.
- [ ] Editing or deleting an audit event breaks the hash chain and is detected.

## Scope & out-of-scopes for the time boxed slice

### Scope

The slice builds the full journey end to end with real security logic, and mocks the external integrations.

1. Request creation, tokens, expiry, reissue (FR-1 to FR-4)
2. One-time code verification and lockout (FR-5, FR-6) - code shown on a mock outbox page instead of real SMS
3. Upload validation and storage (FR-8 to FR-10) - local / simulated object storage
4. Authorisation & security controls (FR-12) - use RBAC with mocked users and roles, no SSO; production will be SSO with fine-grained access control
5. Audit trail (FR-13, FR-14) - hash chained
6. Malware scanning (FR-17) - hook only, mocked and always passed
7. Bankers and customer records - seeded synthetic records
8. Data security & encryption - all data will be stored in a local database not encrypted at rest in the slice; production uses encrypted storage with managed keys

### Out of scope

**Functional**

1. Code resend rate limiting (FR-7) - single code per link session; production adds resend limits
2. Retention purge (FR-15) - retention date is recorded on each file, but no deletion job runs
3. Banker notification (FR-16) - status is visible in the UI; no email or in-app alerts
4. Real malware scanning (FR-17) - hook exists but always passes; production adds scanning with quarantine
5. Real SMS delivery - codes appear on a mock outbox page
6. Integration with the customer master record - customer mobile numbers come from seeded data
7. Legal hold, request cancellation workflows and bulk requests (FR-11)

**Non-functional**

1. Accessibility - no WCAG 2.1 AA conformance testing
2. Data residency - runs locally; production hosting in an Australian region
3. Configurable retention per document type - single default retention period
4. Availability and scaling - single instance, no redundancy or load testing
5. Observability - no alerting or security monitoring (SIEM) feed; audit log only
6. Encryption at rest and key management - see scope item 8
7. Network security - TLS, HSTS and rate limiting assumed at the infrastructure layer
