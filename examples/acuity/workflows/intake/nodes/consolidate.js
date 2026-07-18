// Decide which downstream workloads to call + build each one's payload. Returns a `calls`
// list; the fanout node dispatches all of them in parallel.
export default function consolidate(input, ctx) {
  const action = input.action || "appointment.scheduled";
  const a = input.appt || input.appointment || { id: input.id, type: input.type, email: input.email, name: input.name, price: input.price };
  const typeMap = { "5": "new-patient", "6": "follow-up" };
  const appt = { id: a.id || "unknown", type: a.type || typeMap[input.appointmentTypeID] || "follow-up", email: a.email || "", name: a.name || "", price: Number(a.price || 0) };
  const scheduled = action === "appointment.scheduled";
  const newPatient = appt.type === "new-patient";

  const calls = [{ workflow: "crm-upsert", ref: "workflows/crm-upsert", input: { op: scheduled ? "upsert" : "update-status", patient: appt, status: scheduled ? "active" : "canceled" } }];
  if (scheduled) calls.push({ workflow: "send-confirmation", ref: "workflows/send-confirmation", input: { to: appt.email, channel: "email", template: newPatient ? "welcome" : "reminder", appt } });
  if (scheduled && newPatient) calls.push({ workflow: "create-invoice", ref: "workflows/create-invoice", input: { customer: appt.email, amountCents: Math.round(appt.price * 100), memo: `New patient visit ${appt.id}` } });

  ctx.log.info("routing", { appt: appt.id, targets: calls.map((c) => c.workflow) });
  return { appt, calls };
}
