"use server";

import { z } from "zod";
import { f } from "@/lib/formdata";
import { runAction, type ActionState } from "./run";
import { ALL_PERMISSIONS, type Permission, type Scope } from "../auth/permissions";
import { createUser, disableIntegration, saveProposalTemplate, resetUserPassword, saveAiCredential, saveCustomField, saveListItem, saveOffer, saveRole, saveService, saveSettings, saveStage, setUserRoles, setUserStatus, verifyAi } from "../system/admin";
import { ValidationError } from "../errors";

export async function saveSettingsAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "system.settings",
    action: "settings.save",
    schema: z.object({
      agencyName: f.str(200),
      legalName: f.optStr(200),
      address: f.text(1000),
      email: f.optStr(300),
      phone: f.optStr(100),
      website: f.optStr(300),
      taxIdentifier: f.optStr(100),
      taxIdentifierLabel: f.optStr(50),
      baseCurrency: f.currency(),
      fiscalYearStartMonth: f.int(),
      timeZone: f.str(64),
      invoicePrefix: f.str(20),
      creditNotePrefix: f.str(20),
      defaultPaymentTermsDays: f.int(),
      invoiceFooter: f.text(2000),
      bankDetails: f.text(2000),
      minimumCashThreshold: f.optMoney(),
      expenseApprovalThreshold: f.optMoney(),
      staleOpportunityDays: f.int(),
      renewalLeadDays: f.int(),
      missingTimeLookbackDays: f.int(),
      taxSetupComplete: f.bool().optional(),
      openingBalancesComplete: f.bool().optional(),
    }),
    run: async ({ actor, tx, data }) => {
      const { taxSetupComplete, openingBalancesComplete, ...rest } = data;
      await saveSettings(tx, actor, { ...rest, taxSetupCompletedAt: taxSetupComplete ? new Date() : null, openingBalancesCompletedAt: openingBalancesComplete ? new Date() : null });
      return "Settings saved.";
    },
  });
}

export async function saveServiceAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "system.settings", action: "service.save", schema: z.object({ id: f.id(), name: f.str(200), shortName: f.str(40), description: f.text(), color: f.str(7), active: f.bool() }), run: async ({ actor, tx, data }) => {
    const { id, ...input } = data;
    await saveService(tx, actor, id, input);
    return "Service saved.";
  } });
}

export async function saveOfferAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "system.settings",
    action: "offer.save",
    schema: z.object({ id: f.optId(), serviceId: f.id(), name: f.str(200), description: f.text(), pricingModel: f.enumOf(["fixed", "retainer", "milestone", "hourly"] as const), defaultPrice: f.optMoney(), currency: f.optStr(3), defaultDurationWeeks: f.optInt(), includedRevisions: f.optInt(), deliverablesText: f.text(), active: f.bool() }),
    run: async ({ actor, tx, data }) => {
      await saveOffer(tx, actor, { ...data, deliverables: (data.deliverablesText ?? "").split("\n").map((s) => s.trim()).filter(Boolean) });
      return "Offer saved.";
    },
  });
}

export async function saveListItemAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "system.settings", action: "catalog.list", schema: z.object({ list: f.enumOf(["channel", "contact_role", "lookup"] as const), id: f.optId(), listKey: f.optStr(50), key: f.optStr(50), label: f.str(200), active: f.bool(), sortOrder: f.optInt() }), run: async ({ actor, tx, data }) => {
    await saveListItem(tx, actor, data);
    return "Saved.";
  } });
}

export async function saveCustomFieldAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "system.settings", action: "custom_field.save", schema: z.object({ id: f.optId(), entityType: f.enumOf(["lead", "account", "contact", "opportunity", "engagement"] as const), label: f.str(100), fieldType: f.enumOf(["text", "number", "date", "select", "boolean", "url"] as const), optionsText: f.optStr(2000), required: f.bool(), active: f.bool() }), run: async ({ actor, tx, data }) => {
    await saveCustomField(tx, actor, { ...data, options: (data.optionsText ?? "").split(",").map((s) => s.trim()).filter(Boolean) });
    return "Field saved.";
  } });
}

export async function saveStageAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "system.settings", action: "pipeline.stage", schema: z.object({ id: f.id(), name: f.str(100), probability: f.int(), staleAfterDays: f.optInt(), sortOrder: f.int() }), run: async ({ actor, tx, data }) => {
    const { id, ...input } = data;
    await saveStage(tx, actor, id, input);
    return "Stage saved. Weighted pipeline uses the new probability from now on.";
  } });
}

export async function createUserAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "users.manage", action: "user.create", schema: z.object({ name: f.str(200), email: f.str(300), password: f.str(200), roleIds: f.ids(), title: f.optStr(200), timeZone: f.optStr(64) }), run: async ({ actor, tx, data }) => {
    const u = await createUser(tx, actor, data);
    return { message: `User ${u.email} created. Share the temporary password through a secure channel — no email is sent.`, redirectTo: `/admin/users/${u.id}` };
  } });
}

export async function userAccessAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "users.manage", action: "user.access", schema: z.object({ id: f.str(100), op: f.enumOf(["roles", "disable", "enable", "password"] as const), roleIds: f.ids(), password: f.optStr(200) }), run: async ({ actor, tx, data }) => {
    if (data.op === "roles") {
      await setUserRoles(tx, actor, data.id, data.roleIds);
      return "Roles updated. The user has been signed out so the change applies immediately.";
    }
    if (data.op === "password") {
      if (!data.password) throw new ValidationError("Enter a new password.", { password: "Required" });
      await resetUserPassword(tx, actor, data.id, data.password);
      return "Password reset. Share it securely; the user's sessions were ended.";
    }
    await setUserStatus(tx, actor, data.id, data.op === "disable" ? "disabled" : "active");
    return data.op === "disable" ? "User disabled and signed out." : "User re-enabled.";
  } });
}

export async function saveRoleAction(_p: ActionState, fd: FormData) {
  const grants: Partial<Record<Permission, Scope>> = {};
  for (const p of ALL_PERMISSIONS) {
    const v = fd.get(`perm.${p}`);
    if (v === "all" || v === "assigned") grants[p] = v;
  }
  return runAction(fd, { permission: "users.manage", action: "role.save", schema: z.object({ id: f.optId(), name: f.str(100), description: f.optStr(500) }), run: async ({ actor, tx, data }) => {
    const id = await saveRole(tx, actor, { ...data, grants });
    return { message: "Role saved.", redirectTo: `/admin/roles?role=${id}` };
  } });
}

export async function integrationAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "integrations.manage", action: "integration.ai", schema: z.object({ op: f.enumOf(["save", "verify", "disable"] as const), apiKey: f.optStr(500) }), run: async ({ actor, tx, data }) => {
    if (data.op === "save") {
      if (!data.apiKey) throw new ValidationError("Paste the API key.", { apiKey: "Required" });
      await saveAiCredential(tx, actor, data.apiKey);
      const r = await verifyAi(tx, actor);
      return r.ok ? "Stored encrypted and verified with the provider." : `Stored encrypted, but verification failed: ${r.error}`;
    }
    if (data.op === "verify") {
      const r = await verifyAi(tx, actor);
      return r.ok ? "Verified: the provider accepted the key." : `Verification failed: ${r.error}`;
    }
    await disableIntegration(tx, actor, "ai", "anthropic");
    return "AI assistance disabled and the stored key deleted.";
  } });
}

export async function saveProposalTemplateAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "system.settings",
    action: "proposal_template.save",
    schema: z.object({ id: f.optId(), name: f.str(200), serviceId: f.optId(), offerId: f.optId(), introduction: f.text(), scope: f.text(), deliverablesText: f.text(), exclusions: f.text(), assumptions: f.text(), timeline: f.text(), terms: f.text(), pricingModel: f.enumOf(["fixed", "retainer", "milestone", "hourly"] as const).optional().nullable(), active: f.bool() }),
    run: async ({ actor, tx, data }) => {
      await saveProposalTemplate(tx, actor, { ...data, deliverables: (data.deliverablesText ?? "").split("\n").map((s) => s.trim()).filter(Boolean) });
      return "Template saved. New proposals can start from it; existing proposals are unchanged.";
    },
  });
}
