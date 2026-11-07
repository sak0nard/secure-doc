import { sql } from "drizzle-orm";
import {
  bigserial,
  char,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true });
const id = () => uuid("id").primaryKey().defaultRandom();

export const role = pgEnum("role", ["banker", "compliance"]);
export const requestStatus = pgEnum("request_status", ["open", "received", "closed"]);
export const linkState = pgEnum("link_state", ["active", "used", "revoked", "locked"]);
export const documentType = pgEnum("document_type", ["payslip", "bank_statement", "photo_id", "other"]);
export const detectedType = pgEnum("detected_type", ["pdf", "jpeg", "png"]);
export const scanStatus = pgEnum("scan_status", ["pending", "clean", "infected"]);
export const actorType = pgEnum("actor_type", ["user", "customer", "system"]);
export const auditOutcome = pgEnum("audit_outcome", ["success", "failure", "denied", "suspicious"]);

export const users = pgTable("users", {
  id: id(),
  name: text("name").notNull(),
  role: role("role").notNull(),
});

export const userSessions = pgTable("user_sessions", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  tokenHash: char("token_hash", { length: 64 }).notNull().unique(),
  expiresAt: ts("expires_at").notNull(),
  endedAt: ts("ended_at"),
});

export const customers = pgTable("customers", {
  id: id(),
  name: text("name").notNull(),
  mobile: text("mobile").notNull(),
});

export const requests = pgTable("requests", {
  id: id(),
  customerId: uuid("customer_id")
    .notNull()
    .references(() => customers.id),
  bankerId: uuid("banker_id")
    .notNull()
    .references(() => users.id),
  documentTypes: documentType("document_types").array().notNull(),
  status: requestStatus("status").notNull().default("open"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const uploadLinks = pgTable(
  "upload_links",
  {
    id: id(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id),
    tokenHash: char("token_hash", { length: 64 }).notNull().unique(),
    state: linkState("state").notNull().default("active"),
    issuedAt: ts("issued_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
    failedCodeAttempts: integer("failed_code_attempts").notNull().default(0),
    codesSent: integer("codes_sent").notNull().default(0),
    lastCodeSentAt: ts("last_code_sent_at"),
  },
  (t) => [uniqueIndex("upload_links_one_active_per_request").on(t.requestId).where(sql`${t.state} = 'active'`)],
);

export const otpCodes = pgTable("otp_codes", {
  id: id(),
  linkId: uuid("link_id")
    .notNull()
    .references(() => uploadLinks.id),
  codeHash: char("code_hash", { length: 64 }).notNull(),
  expiresAt: ts("expires_at").notNull(),
  consumedAt: ts("consumed_at"),
});

export const customerSessions = pgTable("customer_sessions", {
  id: id(),
  linkId: uuid("link_id")
    .notNull()
    .references(() => uploadLinks.id),
  tokenHash: char("token_hash", { length: 64 }).notNull().unique(),
  expiresAt: ts("expires_at").notNull(),
  endedAt: ts("ended_at"),
});

export const documents = pgTable("documents", {
  id: id(),
  requestId: uuid("request_id")
    .notNull()
    .references(() => requests.id),
  storageKey: text("storage_key").notNull().unique(),
  documentType: documentType("document_type").notNull(),
  originalFilename: text("original_filename").notNull(),
  detectedType: detectedType("detected_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: char("sha256", { length: 64 }).notNull(),
  scanStatus: scanStatus("scan_status").notNull().default("pending"),
  retentionUntil: date("retention_until").notNull(),
  uploadedAt: ts("uploaded_at").notNull(),
});

/** Mock SMS channel. Holds the plaintext code because it stands in for the customer's phone. */
export const outbox = pgTable("outbox", {
  id: id(),
  linkId: uuid("link_id").references(() => uploadLinks.id),
  toMobile: text("to_mobile").notNull(),
  body: text("body").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const auditEvents = pgTable(
  "audit_events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    at: ts("at").notNull(),
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    requestId: uuid("request_id"),
    sourceIp: text("source_ip").notNull(),
    outcome: auditOutcome("outcome").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull(),
    prevHash: char("prev_hash", { length: 64 }).notNull(),
    hash: char("hash", { length: 64 }).notNull(),
  },
  (t) => [index("audit_events_request_id").on(t.requestId)],
);
