let currentSession = null;
let activeHighlightField = null;

const el = (id) => document.getElementById(id);

async function apiCall(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function showError(msg) {
  const box = el("error-toast");
  if (!msg) {
    box.classList.add("hidden");
    box.textContent = "";
    return;
  }
  box.textContent = msg;
  box.classList.remove("hidden");
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function collectSpans(draft) {
  const spans = [];
  const add = (field, label, spanObj) => {
    if (spanObj && typeof spanObj.start === "number" && typeof spanObj.end === "number") {
      spans.push({ field, label, start: spanObj.start, end: spanObj.end, text: spanObj.text });
    }
  };
  add("recipientName", "Client Name", draft.recipientName?.sourceSpan);
  add("recipientEmail", "Client Email", draft.recipientEmail?.sourceSpan);
  add("currency", "Currency", draft.currency?.sourceSpan);
  add("paymentTerm", "Payment Term", draft.paymentTerm?.sourceSpan);
  add("dueDate", "Due Date", draft.dueDate?.sourceSpan);
  if (draft.items?.[0]?.sourceSpan) {
    add("items", "Line Item Amount", draft.items[0].sourceSpan);
  }
  return spans.sort((a, b) => a.start - b.start);
}

function renderProvenanceHighlight() {
  if (!currentSession) return;
  const raw = currentSession.rawText;
  const spans = collectSpans(currentSession.draft);

  // Deduplicate overlapping spans
  const nonOverlapping = [];
  let cursor = 0;
  for (const sp of spans) {
    if (sp.start >= cursor && sp.end <= raw.length && sp.start < sp.end) {
      nonOverlapping.push(sp);
      cursor = sp.end;
    }
  }

  let html = "";
  let idx = 0;
  for (const sp of nonOverlapping) {
    if (sp.start > idx) {
      html += escapeHtml(raw.slice(idx, sp.start));
    }
    const isActive = activeHighlightField === sp.field ? "active" : "";
    html += `<mark class="source-mark ${isActive}" data-field="${sp.field}" title="${sp.label}: [${sp.start}..${sp.end}]">${escapeHtml(
      raw.slice(sp.start, sp.end)
    )}</mark>`;
    idx = sp.end;
  }
  if (idx < raw.length) {
    html += escapeHtml(raw.slice(idx));
  }

  const container = el("highlighted-source");
  container.innerHTML = html;

  const activeSpan = spans.find((s) => s.field === activeHighlightField);
  const meta = el("active-span-meta");
  if (activeSpan) {
    meta.textContent = `Provenance [${activeSpan.field}]: chars ${activeSpan.start}..${activeSpan.end} → "${activeSpan.text}"`;
  } else {
    meta.textContent =
      spans.length > 0
        ? `${spans.length} exact source span(s) mapped directly from input text. Click or focus any field to inspect.`
        : "No verbatim spans matched.";
  }
}

function updateSpanBadge(fieldKey, fieldObj) {
  const badge = el(`span-tag-${fieldKey}`);
  if (!badge) return;
  const group = document.querySelector(`.form-group[data-field="${fieldKey}"]`);

  if (fieldObj?.isAmbiguous) {
    badge.textContent = "Needs Clarification";
    badge.className = "span-tag missing";
    group?.classList.add("ambiguous-field");
  } else if (fieldObj?.sourceSpan) {
    badge.textContent = `span [${fieldObj.sourceSpan.start}..${fieldObj.sourceSpan.end}] "${fieldObj.sourceSpan.text}"`;
    badge.className = "span-tag";
    group?.classList.remove("ambiguous-field");
  } else if (fieldObj?.value) {
    badge.textContent = "User confirmed";
    badge.className = "span-tag";
    group?.classList.remove("ambiguous-field");
  } else {
    badge.textContent = "Optional / None";
    badge.className = "span-tag";
    group?.classList.remove("ambiguous-field");
  }
}

function renderSession(session) {
  currentSession = session;
  showError(null);

  el("provenance-box").classList.remove("hidden");
  el("review-empty").classList.add("hidden");
  el("review-content").classList.remove("hidden");

  renderProvenanceHighlight();

  const d = session.draft;
  el("input-email").value = d.recipientEmail.value || "";
  el("input-name").value = d.recipientName.value || "";
  el("input-currency").value = d.currency.value || "";
  el("input-term").value = d.paymentTerm.value || "";
  el("input-duedate").value = d.dueDate.value || "";
  el("input-note").value = d.note?.value || "";

  const firstItem = d.items[0] || {
    name: "Deliverable",
    quantity: "1",
    unit_amount: { value: "0.00" },
  };
  el("input-item-name").value = firstItem.name;
  el("input-item-qty").value = firstItem.quantity;
  el("input-item-price").value = firstItem.unit_amount.value;

  updateSpanBadge("recipientEmail", d.recipientEmail);
  updateSpanBadge("recipientName", d.recipientName);
  updateSpanBadge("currency", d.currency);
  updateSpanBadge("paymentTerm", d.paymentTerm);
  updateSpanBadge("dueDate", d.dueDate);

  const itemBadge = el("span-tag-items");
  if (firstItem.sourceSpan) {
    itemBadge.textContent = `span [${firstItem.sourceSpan.start}..${firstItem.sourceSpan.end}] "${firstItem.sourceSpan.text}"`;
    itemBadge.className = "span-tag";
  } else {
    itemBadge.textContent = "User confirmed";
    itemBadge.className = "span-tag";
  }

  // Clarification Questions Banner
  const qBanner = el("questions-banner");
  const rBanner = el("resolved-banner");
  const qList = el("questions-list");
  qList.innerHTML = "";

  if (session.unresolvedQuestions.length > 0) {
    qBanner.classList.remove("hidden");
    rBanner.classList.add("hidden");
    for (const q of session.unresolvedQuestions) {
      const li = document.createElement("li");
      li.innerHTML = `<strong>${escapeHtml(q.field)}:</strong> ${escapeHtml(q.question)}`;
      qList.appendChild(li);
    }
  } else {
    qBanner.classList.add("hidden");
    rBanner.classList.remove("hidden");
  }

  // Lock form inputs once draft is created
  const isLocked = session.flow.stage !== "proposed";
  for (const input of el("draft-form").querySelectorAll("input, select, button")) {
    input.disabled = isLocked;
  }

  // Stage Stepper
  const stages = ["proposed", "draft_created", "sent"];
  const curIdx = stages.indexOf(session.flow.stage);
  stages.forEach((st, idx) => {
    const node = el(`step-${st}`);
    node.className = "stage-node";
    if (idx < curIdx) node.classList.add("done");
    else if (idx === curIdx) node.classList.add("active");
  });

  // Gate 1 & Gate 2 buttons and statuses
  const gate1Status = el("gate1-status");
  const gate1Time = el("gate1-timestamp");
  const btnDraft = el("btn-approve-draft");

  const gate2Status = el("gate2-status");
  const gate2Time = el("gate2-timestamp");
  const btnSend = el("btn-approve-send");

  const hasTimingResolved =
    (Boolean(d.paymentTerm.value) && !d.paymentTerm.isAmbiguous) ||
    (Boolean(d.dueDate.value) && !d.dueDate.isAmbiguous);

  const hasRequiredResolved =
    Boolean(d.recipientEmail.value) &&
    !d.recipientEmail.isAmbiguous &&
    Boolean(d.currency.value) &&
    !d.currency.isAmbiguous &&
    hasTimingResolved &&
    Number(firstItem.unit_amount.value) > 0;

  if (session.flow.stage === "proposed") {
    gate1Status.textContent = hasRequiredResolved ? "Ready for Approval" : "Resolve Questions First";
    gate1Status.className = "gate-badge";
    gate1Time.classList.add("hidden");
    btnDraft.disabled = !hasRequiredResolved;

    gate2Status.textContent = "Locked (Requires Gate 1 Draft)";
    gate2Status.className = "gate-badge";
    gate2Time.classList.add("hidden");
    btnSend.disabled = true;
  } else if (session.flow.stage === "draft_created") {
    gate1Status.textContent = "Approved & Draft Created";
    gate1Status.className = "gate-badge approved";
    gate1Time.textContent = `Approved at: ${session.flow.draftApprovedAt}`;
    gate1Time.classList.remove("hidden");
    btnDraft.disabled = true;

    gate2Status.textContent = "Ready for Send Approval";
    gate2Status.className = "gate-badge";
    gate2Time.classList.add("hidden");
    btnSend.disabled = false;
  } else if (session.flow.stage === "sent") {
    gate1Status.textContent = "Approved & Draft Created";
    gate1Status.className = "gate-badge approved";
    gate1Time.textContent = `Approved at: ${session.flow.draftApprovedAt}`;
    gate1Time.classList.remove("hidden");
    btnDraft.disabled = true;

    gate2Status.textContent = "Approved & Sent to Client";
    gate2Status.className = "gate-badge approved";
    gate2Time.textContent = `Approved at: ${session.flow.sentApprovedAt}`;
    gate2Time.classList.remove("hidden");
    btnSend.disabled = true;
  }

  // PayPal Truth Card
  const truthCard = el("paypal-truth-card");
  if (session.paypalInvoice) {
    truthCard.classList.remove("hidden");
    el("pp-invoice-id").textContent = session.paypalInvoice.id;
    const statusBadge = el("pp-status-badge");
    statusBadge.textContent = session.paypalInvoice.status;
    statusBadge.className = `pp-status-badge ${session.paypalInvoice.status}`;

    const simNotice = el("pp-sim-notice");
    if (session.paypalInvoice.simulationMode) {
      simNotice.classList.remove("hidden");
    } else {
      simNotice.classList.add("hidden");
    }

    const linksDiv = el("pp-links");
    linksDiv.innerHTML = "";
    if (session.paypalInvoice.recipientViewUrl) {
      linksDiv.innerHTML += `<div>Hosted Payer Link: <a href="${escapeHtml(
        session.paypalInvoice.recipientViewUrl
      )}" target="_blank" rel="noreferrer">${escapeHtml(
        session.paypalInvoice.recipientViewUrl
      )}</a></div>`;
    }
    if (session.paypalInvoice.invoicerViewUrl) {
      linksDiv.innerHTML += `<div>Invoicer Dashboard Link: <a href="${escapeHtml(
        session.paypalInvoice.invoicerViewUrl
      )}" target="_blank" rel="noreferrer">${escapeHtml(
        session.paypalInvoice.invoicerViewUrl
      )}</a></div>`;
    }

    const btnSimPay = el("btn-simulate-pay");
    if (
      session.paypalInvoice.simulationMode &&
      session.flow.stage === "sent" &&
      session.paypalInvoice.status !== "PAID"
    ) {
      btnSimPay.classList.remove("hidden");
    } else {
      btnSimPay.classList.add("hidden");
    }
  } else {
    truthCard.classList.add("hidden");
  }

  // Inspector
  el("pre-payload").textContent = session.formattedPayPalPayload
    ? JSON.stringify(session.formattedPayPalPayload, null, 2)
    : "Incomplete required fields (email or currency missing).";
  el("pre-response").textContent = session.paypalInvoice
    ? JSON.stringify(session.paypalInvoice.rawResponse, null, 2)
    : "No PayPal API call executed yet.";
}

async function init() {
  try {
    const config = await apiCall("/api/config");

    const extBadge = el("badge-extraction");
    if (config.modes.extractionMode === "live_ai") {
      extBadge.textContent = "Extraction: LIVE AI (OpenAI)";
      extBadge.classList.add("live");
    } else {
      extBadge.textContent = "Extraction: DETERMINISTIC FALLBACK";
      extBadge.classList.add("sim");
    }

    const ppBadge = el("badge-paypal");
    if (config.modes.paypalMode === "live_sandbox") {
      ppBadge.textContent = "PayPal: LIVE SANDBOX API";
      ppBadge.classList.add("live");
    } else {
      ppBadge.textContent = "PayPal: RECORDED SANDBOX SIMULATION";
      ppBadge.classList.add("sim");
    }

    const scenList = el("scenario-buttons");
    config.scenarios.forEach((sc, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "scenario-btn";
      btn.innerHTML = `<span><strong>${escapeHtml(sc.title)}</strong></span><span class="scenario-badge">${escapeHtml(
        sc.badge
      )}</span>`;
      btn.addEventListener("click", () => {
        el("raw-text-input").value = sc.rawText;
      });
      scenList.appendChild(btn);
      if (index === 0) {
        el("raw-text-input").value = sc.rawText;
      }
    });
  } catch (err) {
    showError(err.message);
  }

  // Extract button
  el("btn-extract").addEventListener("click", async () => {
    try {
      showError(null);
      const rawText = el("raw-text-input").value;
      const session = await apiCall("/api/sessions/extract", {
        method: "POST",
        body: JSON.stringify({ rawText }),
      });
      renderSession(session);
    } catch (err) {
      showError(err.message);
    }
  });

  // Save draft edits
  el("draft-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentSession) return;
    try {
      showError(null);
      const patch = {
        recipientEmail: el("input-email").value,
        recipientName: el("input-name").value,
        currency: el("input-currency").value,
        paymentTerm: el("input-term").value,
        dueDate: el("input-duedate").value || null,
        note: el("input-note").value,
        items: [
          {
            name: el("input-item-name").value,
            quantity: String(el("input-item-qty").value || "1"),
            unitPrice: String(el("input-item-price").value || "0.00"),
          },
        ],
      };
      const updated = await apiCall(`/api/sessions/${currentSession.id}/draft`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      renderSession(updated);
    } catch (err) {
      showError(err.message);
    }
  });

  // Gate 1: Approve & Create Draft
  el("btn-approve-draft").addEventListener("click", async () => {
    if (!currentSession) return;
    try {
      showError(null);
      const updated = await apiCall(
        `/api/sessions/${currentSession.id}/approve-draft`,
        { method: "POST" }
      );
      renderSession(updated);
    } catch (err) {
      showError(err.message);
    }
  });

  // Gate 2: Approve & Send Invoice
  el("btn-approve-send").addEventListener("click", async () => {
    if (!currentSession) return;
    try {
      showError(null);
      const updated = await apiCall(
        `/api/sessions/${currentSession.id}/approve-send`,
        { method: "POST" }
      );
      renderSession(updated);
    } catch (err) {
      showError(err.message);
    }
  });

  // Refresh Status
  el("btn-refresh-status").addEventListener("click", async () => {
    if (!currentSession) return;
    try {
      showError(null);
      const updated = await apiCall(
        `/api/sessions/${currentSession.id}/refresh-status`,
        { method: "POST" }
      );
      renderSession(updated);
    } catch (err) {
      showError(err.message);
    }
  });

  // Simulate Sandbox Buyer Payment
  el("btn-simulate-pay").addEventListener("click", async () => {
    if (!currentSession) return;
    try {
      showError(null);
      const updated = await apiCall(
        `/api/sessions/${currentSession.id}/simulate-pay`,
        { method: "POST" }
      );
      renderSession(updated);
    } catch (err) {
      showError(err.message);
    }
  });

  // Highlight provenance span on field focus/hover
  document.querySelectorAll("[data-field]").forEach((node) => {
    node.addEventListener("mouseenter", () => {
      activeHighlightField = node.getAttribute("data-field");
      renderProvenanceHighlight();
    });
    node.addEventListener("focusin", () => {
      activeHighlightField = node.getAttribute("data-field");
      renderProvenanceHighlight();
    });
  });
}

init();
