/**
 * Permission catalogue. Permissions are `module.action`. Each grant has a scope:
 *  - "all": every record in the module
 *  - "assigned": only records the user owns or is explicitly assigned to
 * Enforcement happens on the server (pages, server actions, route handlers,
 * exports, search and file downloads) via src/server/auth/context.ts.
 */
export const PERMISSIONS = {
  "operations.view": "View Operations dashboards and calendar",
  "crm.read": "View leads, accounts, contacts, opportunities and activity",
  "crm.write": "Create and edit CRM records, log activity",
  "crm.import": "Import leads/contacts and merge duplicates",
  "crm.export": "Export CRM data",
  "outreach.send": "Approve outreach drafts and mark them sent",
  "proposals.approve": "Approve proposals internally",
  "delivery.read": "View engagements, projects, deliverables and tasks",
  "delivery.write": "Edit engagements, tasks, deliverables and scope",
  "delivery.approve": "Record deliverable approvals and approve scope changes",
  "time.write": "Log own time",
  "time.approve": "Review and approve timesheets",
  "expenses.submit": "Submit expenses",
  "finance.read": "View invoices, payments, bills, bank and revenue figures",
  "finance.write": "Create and edit draft financial records, record payments",
  "finance.post": "Issue invoices, approve bills/expenses, post journals",
  "finance.admin": "Chart of accounts, periods, opening balances, tax setup",
  "finance.export": "Export financial data and reports",
  "reports.read": "View financial statements and management reports",
  "costrates.read": "View internal cost rates and salary-derived costs",
  "costrates.write": "Edit internal cost rates",
  "people.read": "View the people directory and capacity",
  "people.write": "Edit people records, leave approvals and checklists",
  "people.private": "Access private employment documents and HR details",
  "documents.read": "View and download documents linked to visible records",
  "documents.write": "Upload and manage documents",
  "system.settings": "Agency settings, catalog, pipelines, custom fields",
  "integrations.manage": "Configure integrations and authorise external sending",
  "audit.read": "View audit logs and system health",
  "users.manage": "Manage users, roles and permissions",
  "ai.use": "Use optional AI assistance",
} as const;

export type Permission = keyof typeof PERMISSIONS;
export type Scope = "all" | "assigned";
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const PERMISSION_GROUPS: { label: string; permissions: Permission[] }[] = [
  { label: "Operations", permissions: ["operations.view"] },
  { label: "CRM & Commercial", permissions: ["crm.read", "crm.write", "crm.import", "crm.export", "outreach.send", "proposals.approve"] },
  { label: "Clients & Delivery", permissions: ["delivery.read", "delivery.write", "delivery.approve", "time.write", "time.approve"] },
  {
    label: "Finance",
    permissions: ["finance.read", "finance.write", "finance.post", "finance.admin", "finance.export", "reports.read", "expenses.submit"],
  },
  { label: "People", permissions: ["people.read", "people.write", "people.private", "costrates.read", "costrates.write"] },
  { label: "Documents", permissions: ["documents.read", "documents.write"] },
  { label: "System", permissions: ["system.settings", "integrations.manage", "audit.read", "users.manage", "ai.use"] },
];

type Grant = Partial<Record<Permission, Scope>>;
const all = (...perms: Permission[]): Grant => Object.fromEntries(perms.map((p) => [p, "all" as const]));
const assigned = (...perms: Permission[]): Grant => Object.fromEntries(perms.map((p) => [p, "assigned" as const]));

export type RoleKey =
  | "owner"
  | "operations_manager"
  | "account_manager"
  | "sales"
  | "finance"
  | "team_member"
  | "contractor"
  | "read_only";

export const DEFAULT_ROLES: Record<RoleKey, { name: string; description: string; grants: Grant }> = {
  owner: {
    name: "Owner / Administrator",
    description: "Full access to every module, including users, permissions and private HR records.",
    grants: all(...ALL_PERMISSIONS),
  },
  operations_manager: {
    name: "Operations Manager",
    description: "Runs daily operations, delivery, people and settings. No user administration or private HR files.",
    grants: all(
      "operations.view", "crm.read", "crm.write", "crm.import", "crm.export", "outreach.send", "proposals.approve",
      "delivery.read", "delivery.write", "delivery.approve", "time.write", "time.approve", "expenses.submit",
      "finance.read", "reports.read", "costrates.read", "people.read", "people.write",
      "documents.read", "documents.write", "system.settings", "integrations.manage", "audit.read", "ai.use",
    ),
  },
  account_manager: {
    name: "Account / Project Manager",
    description: "Manages client relationships and delivery. Finance figures for their own accounts only.",
    grants: {
      ...all("operations.view", "crm.read", "crm.write", "delivery.read", "time.write", "expenses.submit", "people.read", "documents.read", "documents.write", "ai.use"),
      ...assigned("delivery.write", "delivery.approve", "time.approve", "finance.read"),
    },
  },
  sales: {
    name: "Sales",
    description: "Leads, outreach, opportunities and proposals. No salaries, cost rates or accounting.",
    grants: {
      ...all("operations.view", "crm.read", "crm.write", "crm.import", "crm.export", "outreach.send", "documents.read", "documents.write", "people.read", "time.write", "expenses.submit", "ai.use"),
      ...assigned("delivery.read"),
    },
  },
  finance: {
    name: "Finance",
    description: "Accounting, invoicing, payments and reports. No automatic access to private HR files.",
    grants: all(
      "operations.view", "crm.read", "delivery.read", "finance.read", "finance.write", "finance.post", "finance.admin",
      "finance.export", "reports.read", "costrates.read", "people.read", "documents.read", "documents.write",
      "time.write", "time.approve", "expenses.submit", "audit.read",
    ),
  },
  team_member: {
    name: "Team Member",
    description: "Works on assigned delivery tasks, logs time and expenses.",
    grants: {
      ...all("operations.view", "time.write", "expenses.submit", "people.read"),
      ...assigned("crm.read", "delivery.read", "delivery.write", "documents.read", "documents.write"),
    },
  },
  contractor: {
    name: "Contractor",
    description: "Only explicitly assigned engagements, tasks and files.",
    grants: {
      ...all("time.write"),
      ...assigned("delivery.read", "delivery.write"),
    },
  },
  read_only: {
    name: "Read-only",
    description: "Can view operational, CRM, delivery and finance records but never change anything.",
    grants: all("operations.view", "crm.read", "delivery.read", "finance.read", "reports.read", "people.read", "documents.read"),
  },
};

/** Permissions that mutate data — never granted to read-only users (asserted in tests). */
export const MUTATING_PERMISSIONS: Permission[] = ALL_PERMISSIONS.filter(
  (p) => !p.endsWith(".read") && p !== "operations.view",
);
