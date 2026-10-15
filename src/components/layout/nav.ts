import type { Permission } from "@/server/auth/permissions";

export type NavItem = { label: string; href: string; perm?: Permission[] };
export type NavSection = { key: string; label: string; perm?: Permission[]; items: NavItem[] };

/** Primary navigation. Items are hidden when the user lacks every listed permission. */
export const NAV: NavSection[] = [
  {
    key: "operations",
    label: "Operations",
    perm: ["operations.view"],
    items: [
      { label: "Daily dashboard", href: "/operations" },
      { label: "Agency calendar", href: "/operations/calendar" },
    ],
  },
  {
    key: "crm",
    label: "CRM & Commercial",
    perm: ["crm.read"],
    items: [
      { label: "Overview", href: "/crm" },
      { label: "Leads", href: "/crm/leads" },
      { label: "Accounts", href: "/crm/accounts" },
      { label: "Contacts", href: "/crm/contacts" },
      { label: "Opportunities", href: "/crm/opportunities" },
      { label: "Proposals", href: "/crm/proposals" },
      { label: "Outreach & campaigns", href: "/crm/outreach" },
      { label: "Commercial documents", href: "/crm/documents", perm: ["documents.read"] },
      { label: "Analytics", href: "/crm/analytics" },
    ],
  },
  {
    key: "delivery",
    label: "Clients & Delivery",
    perm: ["delivery.read"],
    items: [
      { label: "All clients", href: "/delivery" },
      { label: "Creative Direction", href: "/delivery/service/creative" },
      { label: "Strategy & Advisory", href: "/delivery/service/advisory" },
      { label: "Executive Communication", href: "/delivery/service/executive" },
      { label: "Engagements", href: "/delivery/engagements" },
      { label: "Offer performance", href: "/delivery/offers", perm: ["reports.read"] },
      { label: "Client insights", href: "/delivery/insights", perm: ["finance.read"] },
    ],
  },
  {
    key: "finance",
    label: "Finance",
    perm: ["finance.read", "expenses.submit"],
    items: [
      { label: "Collections & payments", href: "/finance/collections", perm: ["finance.read"] },
      { label: "Invoices", href: "/finance/invoices", perm: ["finance.read"] },
      { label: "Bills & expenses", href: "/finance/bills", perm: ["finance.read", "expenses.submit"] },
      { label: "Bank & spending", href: "/finance/bank", perm: ["finance.read"] },
      { label: "Cash & working capital", href: "/finance/cash", perm: ["finance.read"] },
      { label: "Margins", href: "/finance/margins", perm: ["reports.read"] },
      { label: "Accounting", href: "/finance/accounting", perm: ["finance.read"] },
      { label: "Reports", href: "/finance/reports", perm: ["reports.read"] },
      { label: "Tax & compliance", href: "/finance/tax", perm: ["finance.read"] },
      { label: "Suppliers & contractors", href: "/finance/suppliers", perm: ["finance.read"] },
    ],
  },
  {
    key: "people",
    label: "People",
    perm: ["people.read", "time.write"],
    items: [
      { label: "Directory", href: "/people", perm: ["people.read"] },
      { label: "Tasks", href: "/people/tasks" },
      { label: "Timesheets", href: "/people/timesheets", perm: ["time.write", "time.approve"] },
      { label: "Leave", href: "/people/leave", perm: ["people.read"] },
      { label: "Capacity", href: "/people/capacity", perm: ["people.read"] },
    ],
  },
  {
    key: "system",
    label: "System & Integrations",
    perm: ["system.settings", "integrations.manage", "audit.read"],
    items: [
      { label: "Agency settings", href: "/system/settings", perm: ["system.settings"] },
      { label: "Services & offers", href: "/system/catalog", perm: ["system.settings"] },
      { label: "Pipelines & fields", href: "/system/pipelines", perm: ["system.settings"] },
      { label: "Templates", href: "/system/templates", perm: ["system.settings"] },
      { label: "Integrations", href: "/system/integrations", perm: ["integrations.manage"] },
      { label: "Imports & exports", href: "/system/data", perm: ["system.settings", "crm.export", "finance.export"] },
      { label: "Audit log", href: "/system/audit", perm: ["audit.read"] },
      { label: "Jobs & health", href: "/system/jobs", perm: ["audit.read"] },
    ],
  },
  {
    key: "admin",
    label: "Users & Permissions",
    perm: ["users.manage"],
    items: [
      { label: "Users", href: "/admin/users" },
      { label: "Roles & permissions", href: "/admin/roles" },
    ],
  },
];
