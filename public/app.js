let currentSession = null;
let activeHighlightField = null;
let isFormDirty = false;
let editableItems = [];

const el = (id) => document.getElementById(id);

const CURRENCY_SYMBOLS = {
  USD: "$",
  EUR: "€",
  SGD: "S$",
  GBP: "£",
  AUD: "A$",
};

const FIELD_LABELS = {
  recipientName: "Client Name",
  recipientEmail: "Client Billing Email",
  currency: "Currency",
  paymentTerm: "Payment Term",
  dueDate: "Due Date",
  items: "Line Item Deliverable",
};

const TERM_LABELS = {
  DUE_ON_RECEIPT: "Due on Receipt",
  NET_10: "Net 10 (10 days)",
  NET_14: "Net 14 (14 days)",
  NET_15: "Net 15 (15 days)",
  NET_30: "Net 30 (30 days)",
  NET_45: "Net 45 (45 days)",
  NET_60: "Net 60 (60 days)",
};

function getCurrencySymbol(code) {
  return CURRENCY_SYMBOLS[code] || "¤";
}

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

function showError(msg, context = "Error") {
  const box = el("error-toast");
  const ctxBadge = el("error-toast-context");
  const msgSpan = el("error-toast-msg");
  if (!msg) {
    box.classList.add("hidden");
    msgSpan.textContent = "";
    return;
  }
  ctxBadge.textContent = context;
  msgSpan.textContent = msg;
  box.classList.remove("hidden");
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncateQuote(text, maxLen = 28) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1)}…`;
}

function collectSpans(draft) {
  const spans = [];
  const add = (field, label, spanObj) => {
    if (spanObj && typeof spanObj.start === "number" && typeof spanObj.end === "number") {
      spans.push({ field, label, start: spanObj.start, end: spanObj.end, text: spanObj.text });
    }
  };
  add("recipientName", FIELD_LABELS.recipientName, draft.recipientName?.sourceSpan);
  add("recipientEmail", FIELD_LABELS.recipientEmail, draft.recipientEmail?.sourceSpan);
  add("currency", FIELD_LABELS.currency, draft.currency?.sourceSpan);
  add("paymentTerm", FIELD_LABELS.paymentTerm, draft.paymentTerm?.sourceSpan);
  add("dueDate", FIELD_LABELS.dueDate, draft.dueDate?.sourceSpan);
  if (Array.isArray(draft.items)) {
    draft.items.forEach((item, idx) => {
      if (item?.sourceSpan) {
        add(
          "items",
          draft.items.length > 1 ? `Line Item #${idx + 1}` : FIELD_LABELS.items,
          item.sourceSpan
        );
      }
    });
  }
  return spans.sort((a, b) => a.start - b.start);
}

function focusFieldForSpan(fieldKey) {
  const targetMap = {
    recipientEmail: "input-email",
    recipientName: "input-name",
    currency: "input-currency",
    paymentTerm: "input-term",
    dueDate: "input-duedate",
    items: "input-item-name-0",
  };
  const inputId = targetMap[fieldKey];
  const inputEl = inputId ? el(inputId) : null;
  if (inputEl && !inputEl.disabled) {
    inputEl.focus();
  }
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
    const ariaLabel = `Matched quote for ${sp.label}: ${sp.text}`;
    html += `<mark class="source-mark ${isActive}" tabindex="0" role="button" data-field="${escapeHtml(
      sp.field
    )}" aria-label="${escapeHtml(ariaLabel)}" title="Matched ${escapeHtml(sp.label)}">${escapeHtml(
      raw.slice(sp.start, sp.end)
    )}</mark>`;
    idx = sp.end;
  }
  if (idx < raw.length) {
    html += escapeHtml(raw.slice(idx));
  }

  const container = el("highlighted-source");
  container.innerHTML = html;

  // Make highlighted <mark> elements interactive by click and keyboard
  container.querySelectorAll(".source-mark").forEach((markEl) => {
    const activate = () => {
      const f = markEl.getAttribute("data-field");
      activeHighlightField = f;
      renderProvenanceHighlight();
      focusFieldForSpan(f);
    };
    markEl.addEventListener("click", activate);
    markEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        activate();
      }
    });
  });

  const matchingSpans = spans.filter((s) => s.field === activeHighlightField);
  const meta = el("active-span-meta");
  if (matchingSpans.length > 0) {
    const label = FIELD_LABELS[activeHighlightField] || activeHighlightField;
    const quotes = matchingSpans.map((s) => `"${s.text}"`).join(", ");
    meta.textContent = `Matched quote for ${label}: ${quotes}`;
  } else {
    meta.textContent =
      spans.length > 0
        ? `${spans.length} quote(s) linked from the client message. Click any quote above or select a field in Step 2.`
        : "No direct text quotes matched.";
  }

  // Populate raw character offsets inside Developer Inspector only
  const preSpans = el("pre-spans");
  if (preSpans) {
    preSpans.textContent =
      spans.length > 0
        ? JSON.stringify(
            spans.map((s) => ({
              field: s.field,
              label: s.label,
              offsets: `[${s.start}..${s.end}]`,
              verbatimText: s.text,
            })),
            null,
            2
          )
        : "No verbatim source spans recorded.";
  }
}

function updateSpanBadge(fieldKey, fieldObj, isRequired = false) {
  const badge = el(`span-tag-${fieldKey}`);
  if (!badge) return;
  const group = document.querySelector(`.form-group[data-field="${fieldKey}"]`);

  if (fieldObj?.isAmbiguous) {
    badge.textContent = isRequired ? "Missing — Required" : "Needs Review";
    badge.className = "span-tag missing";
    group?.classList.add("ambiguous-field");
  } else if (fieldObj?.sourceSpan) {
    badge.textContent = `Quote: "${truncateQuote(fieldObj.sourceSpan.text)}"`;
    badge.className = "span-tag";
    group?.classList.remove("ambiguous-field");
  } else if (fieldObj?.value) {
    badge.textContent = "Edited by you";
    badge.className = "span-tag";
    group?.classList.remove("ambiguous-field");
  } else {
    badge.textContent = "Optional";
    badge.className = "span-tag";
    group?.classList.remove("ambiguous-field");
  }
}

function setFormDirty(dirty) {
  isFormDirty = dirty;
  const indicator = el("dirty-indicator");
  const saveBtn = el("btn-save-draft");
  if (!indicator || !saveBtn) return;

  if (dirty && currentSession?.flow?.stage === "proposed") {
    indicator.classList.remove("hidden");
    saveBtn.classList.add("dirty-highlight");
  } else {
    indicator.classList.add("hidden");
    saveBtn.classList.remove("dirty-highlight");
  }
  updateGateControls();
}

function computeInvoiceTotal() {
  let sum = 0;
  for (const item of editableItems) {
    const qty = Number(item.quantity) || 0;
    const price = Number(item.unitPrice) || 0;
    sum += qty * price;
  }
  return sum;
}

function updateInvoiceTotalDisplay() {
  const currCode = el("input-currency").value || currentSession?.draft?.currency?.value || "USD";
  const sym = getCurrencySymbol(currCode);
  const total = computeInvoiceTotal();
  el("invoice-total-display").textContent = `${currCode} ${sym}${total.toFixed(2)}`;

  // Also update all currency prefix badges inside line items
  document.querySelectorAll(".currency-prefix").forEach((node) => {
    node.textContent = sym;
  });
}

function renderLineItems(isLocked) {
  const container = el("line-items-list");
  container.innerHTML = "";
  const currCode = el("input-currency").value || currentSession?.draft?.currency?.value || "USD";
  const sym = getCurrencySymbol(currCode);

  editableItems.forEach((item, idx) => {
    const card = document.createElement("div");
    card.className = "line-item-card";

    const quoteBadgeHtml = item.sourceSpan
      ? `<span class="span-tag">Quote: "${escapeHtml(truncateQuote(item.sourceSpan.text))}"</span>`
      : `<span class="span-tag">Edited by you</span>`;

    const removeBtnHtml =
      editableItems.length > 1 && !isLocked
        ? `<button type="button" class="btn btn-danger-small btn-remove-item" data-index="${idx}" aria-label="Remove line item ${
            idx + 1
          }">Remove</button>`
        : "";

    card.innerHTML = `
      <div class="line-item-card-top">
        <span class="line-item-index">Item #${idx + 1}</span>
        <div style="display:flex; align-items:center; gap:6px;">
          ${quoteBadgeHtml}
          ${removeBtnHtml}
        </div>
      </div>
      <div class="item-grid">
        <div class="item-field">
          <label for="input-item-name-${idx}">Deliverable Description <span class="req" aria-hidden="true">*</span></label>
          <input
            type="text"
            id="input-item-name-${idx}"
            data-item-index="${idx}"
            data-item-prop="name"
            value="${escapeHtml(item.name)}"
            required
            ${isLocked ? "disabled" : ""}
          />
        </div>
        <div class="item-field">
          <label for="input-item-qty-${idx}">Qty <span class="req" aria-hidden="true">*</span></label>
          <input
            type="number"
            id="input-item-qty-${idx}"
            data-item-index="${idx}"
            data-item-prop="quantity"
            min="1"
            step="1"
            value="${escapeHtml(item.quantity)}"
            required
            ${isLocked ? "disabled" : ""}
          />
        </div>
        <div class="item-field">
          <label for="input-item-price-${idx}">Unit Amount <span class="req" aria-hidden="true">*</span></label>
          <div class="currency-input-wrap">
            <span class="currency-prefix" aria-hidden="true">${escapeHtml(sym)}</span>
            <input
              type="number"
              id="input-item-price-${idx}"
              data-item-index="${idx}"
              data-item-prop="unitPrice"
              min="0.01"
              step="0.01"
              value="${escapeHtml(item.unitPrice)}"
              required
              ${isLocked ? "disabled" : ""}
            />
          </div>
        </div>
      </div>
    `;
    container.appendChild(card);
  });

  // Wire input listeners on line items
  container.querySelectorAll("input[data-item-index]").forEach((inp) => {
    inp.addEventListener("input", () => {
      const idx = Number(inp.getAttribute("data-item-index"));
      const prop = inp.getAttribute("data-item-prop");
      if (editableItems[idx] && prop) {
        editableItems[idx][prop] = inp.value;
      }
      updateInvoiceTotalDisplay();
      setFormDirty(true);
    });
  });

  // Wire remove buttons
  container.querySelectorAll(".btn-remove-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-index"));
      if (editableItems.length > 1) {
        editableItems.splice(idx, 1);
        renderLineItems(isLocked);
        updateInvoiceTotalDisplay();
        setFormDirty(true);
      }
    });
  });

  const addBtn = el("btn-add-item");
  if (addBtn) {
    addBtn.disabled = isLocked;
  }

  updateInvoiceTotalDisplay();
}

function getFormMissingReasons() {
  const reasons = [];
  const email = el("input-email").value.trim();
  const currency = el("input-currency").value.trim();
  const term = el("input-term").value.trim();
  const dueDate = el("input-duedate").value.trim();

  if (!email) reasons.push("Client Billing Email");
  if (!currency) reasons.push("Currency");
  if (!term && !dueDate) reasons.push("Payment Term or Specific Due Date");

  const hasValidItems =
    editableItems.length > 0 &&
    editableItems.every(
      (it) => String(it.name || "").trim().length > 0 && Number(it.unitPrice) > 0 && Number(it.quantity) > 0
    );
  if (!hasValidItems) {
    reasons.push("Line Item amount (> 0)");
  }
  return reasons;
}

function updateGateControls() {
  if (!currentSession) return;

  const gate1Status = el("gate1-status");
  const gate1Time = el("gate1-timestamp");
  const gate1Reason = el("gate1-reason");
  const btnDraft = el("btn-approve-draft");

  const gate2Status = el("gate2-status");
  const gate2Time = el("gate2-timestamp");
  const gate2Reason = el("gate2-reason");
  const btnSend = el("btn-approve-send");
  const confirmBox = el("gate2-confirm-box");

  const missingReasons = getFormMissingReasons();
  const canApproveGate1 = missingReasons.length === 0;

  if (currentSession.flow.stage === "proposed") {
    gate1Status.textContent = canApproveGate1 ? "Ready for Approval" : "Action Needed in Step 2";
    gate1Status.className = "gate-badge";
    gate1Time.classList.add("hidden");
    btnDraft.disabled = !canApproveGate1;

    if (!canApproveGate1) {
      gate1Reason.textContent = `Complete required fields in Step 2 first: ${missingReasons.join(", ")}.`;
    } else if (isFormDirty) {
      gate1Reason.textContent =
        "Your edits in Step 2 will be saved automatically before creating the PayPal draft.";
    } else {
      gate1Reason.textContent = "All required fields are verified. Click above to create the PayPal draft.";
    }

    gate2Status.textContent = "Locked (Requires Gate 1)";
    gate2Status.className = "gate-badge";
    gate2Time.classList.add("hidden");
    btnSend.disabled = true;
    btnSend.classList.remove("hidden");
    confirmBox.classList.add("hidden");
    gate2Reason.textContent = "Complete Gate 1 first to create the PayPal draft before sending.";
  } else if (currentSession.flow.stage === "draft_created") {
    gate1Status.textContent = "Approved & Draft Created";
    gate1Status.className = "gate-badge approved";
    gate1Time.textContent = `Approved at: ${currentSession.flow.draftApprovedAt}`;
    gate1Time.classList.remove("hidden");
    btnDraft.disabled = true;
    gate1Reason.textContent = "PayPal draft created. Proceed to Gate 2 below when ready to send.";

    gate2Status.textContent = "Ready to Send";
    gate2Status.className = "gate-badge";
    gate2Time.classList.add("hidden");
    btnSend.disabled = false;
    gate2Reason.textContent = "You will review a final summary before the invoice is emailed to the client.";
  } else if (currentSession.flow.stage === "sent") {
    gate1Status.textContent = "Approved & Draft Created";
    gate1Status.className = "gate-badge approved";
    gate1Time.textContent = `Approved at: ${currentSession.flow.draftApprovedAt}`;
    gate1Time.classList.remove("hidden");
    btnDraft.disabled = true;
    gate1Reason.textContent = "Completed.";

    gate2Status.textContent = "Approved & Sent to Client";
    gate2Status.className = "gate-badge approved";
    gate2Time.textContent = `Approved at: ${currentSession.flow.sentApprovedAt}`;
    gate2Time.classList.remove("hidden");
    btnSend.disabled = true;
    btnSend.classList.remove("hidden");
    confirmBox.classList.add("hidden");
    gate2Reason.textContent = "Invoice has been sent to the recipient.";
  }
}

function renderSession(session) {
  currentSession = session;
  isFormDirty = false;
  showError(null);

  el("provenance-box").classList.remove("hidden");
  el("review-empty").classList.add("hidden");
  el("review-content").classList.remove("hidden");
  el("gate2-confirm-box").classList.add("hidden");
  el("btn-approve-send").classList.remove("hidden");

  renderProvenanceHighlight();

  const d = session.draft;
  el("input-email").value = d.recipientEmail.value || "";
  el("input-name").value = d.recipientName.value || "";
  el("input-currency").value = d.currency.value || "";
  el("input-term").value = d.paymentTerm.value || "";
  el("input-duedate").value = d.dueDate.value || "";
  el("input-note").value = d.note?.value || "";

  editableItems = (d.items || []).map((item) => ({
    name: item.name || "Deliverable",
    quantity: String(item.quantity || "1"),
    unitPrice: String(item.unit_amount?.value || "0.00"),
    sourceSpan: item.sourceSpan || null,
  }));
  if (editableItems.length === 0) {
    editableItems.push({
      name: "Deliverable",
      quantity: "1",
      unitPrice: "0.00",
      sourceSpan: null,
    });
  }

  const isLocked = session.flow.stage !== "proposed";
  renderLineItems(isLocked);

  updateSpanBadge("recipientEmail", d.recipientEmail, true);
  updateSpanBadge("recipientName", d.recipientName, false);
  updateSpanBadge("currency", d.currency, true);
  updateSpanBadge("paymentTerm", d.paymentTerm, !d.dueDate.value);
  updateSpanBadge("dueDate", d.dueDate, false);

  const itemBadge = el("span-tag-items");
  const matchedItemSpans = (d.items || []).filter((it) => it.sourceSpan);
  if (matchedItemSpans.length > 0) {
    itemBadge.textContent =
      d.items.length > 1
        ? `${matchedItemSpans.length} of ${d.items.length} items quoted from text`
        : `Quote: "${truncateQuote(matchedItemSpans[0].sourceSpan.text)}"`;
    itemBadge.className = "span-tag";
  } else {
    itemBadge.textContent = "Edited by you";
    itemBadge.className = "span-tag";
  }

  // Locked Banner
  const lockedBanner = el("locked-banner");
  if (isLocked) {
    lockedBanner.classList.remove("hidden");
  } else {
    lockedBanner.classList.add("hidden");
  }

  // Missing / Unclear Questions Banner
  const qBanner = el("questions-banner");
  const rBanner = el("resolved-banner");
  const qList = el("questions-list");
  qList.innerHTML = "";

  if (session.unresolvedQuestions.length > 0) {
    qBanner.classList.remove("hidden");
    rBanner.classList.add("hidden");
    for (const q of session.unresolvedQuestions) {
      const li = document.createElement("li");
      const friendlyField = FIELD_LABELS[q.field] || q.field;
      li.innerHTML = `<strong>${escapeHtml(friendlyField)}:</strong> ${escapeHtml(q.question)}`;
      qList.appendChild(li);
    }
  } else {
    qBanner.classList.add("hidden");
    rBanner.classList.remove("hidden");
  }

  // Lock form inputs once draft is created
  for (const input of el("draft-form").querySelectorAll("input, select, button")) {
    input.disabled = isLocked;
  }

  // Stage Stepper with check marks on completed stages
  const stages = [
    { key: "proposed", num: 1, label: "Proposed" },
    { key: "draft_created", num: 2, label: "Draft Created" },
    { key: "sent", num: 3, label: "Sent" },
  ];
  const curIdx = stages.findIndex((s) => s.key === session.flow.stage);
  stages.forEach((st, idx) => {
    const node = el(`step-${st.key}`);
    node.className = "stage-node";
    node.removeAttribute("aria-current");
    if (idx < curIdx) {
      node.classList.add("done");
      node.textContent = `✓ ${st.num}. ${st.label}`;
    } else if (idx === curIdx) {
      node.classList.add("active");
      node.setAttribute("aria-current", "step");
      node.textContent = `${st.num}. ${st.label}`;
    } else {
      node.textContent = `${st.num}. ${st.label}`;
    }
  });

  setFormDirty(false);
  updateGateControls();

  // PayPal Status Card
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

  // Developer Inspector
  el("pre-payload").textContent = session.formattedPayPalPayload
    ? JSON.stringify(session.formattedPayPalPayload, null, 2)
    : "Incomplete required fields (email, currency, or payment term missing).";
  el("pre-response").textContent = session.paypalInvoice
    ? JSON.stringify(session.paypalInvoice.rawResponse, null, 2)
    : "No PayPal API call executed yet.";
}

function buildPatchFromForm() {
  return {
    recipientEmail: el("input-email").value.trim(),
    recipientName: el("input-name").value.trim(),
    currency: el("input-currency").value.trim(),
    paymentTerm: el("input-term").value.trim(),
    dueDate: el("input-duedate").value.trim() || null,
    note: el("input-note").value,
    items: editableItems.map((it, idx) => ({
      name: String(it.name || "").trim() || `Deliverable ${idx + 1}`,
      quantity: String(it.quantity || "1").trim() || "1",
      unitPrice: String(it.unitPrice || "0.00").trim() || "0.00",
    })),
  };
}

async function saveDraftFromForm() {
  if (!currentSession) return null;
  const patch = buildPatchFromForm();
  const updated = await apiCall(`/api/sessions/${currentSession.id}/draft`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  renderSession(updated);
  return updated;
}

async function init() {
  el("error-toast-close").addEventListener("click", () => showError(null));

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
    showError(err.message, "Setup Error");
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
      showError(err.message, "Step 1 • Extract");
    }
  });

  // Track dirty state on Step 2 form controls
  ["input-email", "input-name", "input-currency", "input-term", "input-duedate", "input-note"].forEach(
    (id) => {
      const control = el(id);
      if (!control) return;
      const handler = () => {
        if (id === "input-currency") {
          updateInvoiceTotalDisplay();
        }
        setFormDirty(true);
      };
      control.addEventListener("input", handler);
      control.addEventListener("change", handler);
    }
  );

  // Add line item button
  el("btn-add-item").addEventListener("click", () => {
    if (!currentSession || currentSession.flow.stage !== "proposed") return;
    editableItems.push({
      name: `Deliverable ${editableItems.length + 1}`,
      quantity: "1",
      unitPrice: "0.00",
      sourceSpan: null,
    });
    renderLineItems(false);
    setFormDirty(true);
    const newInput = el(`input-item-name-${editableItems.length - 1}`);
    if (newInput) newInput.focus();
  });

  // Save draft edits explicitly
  el("draft-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentSession) return;
    try {
      showError(null);
      await saveDraftFromForm();
    } catch (err) {
      showError(err.message, "Step 2 • Save Changes");
    }
  });

  // Gate 1: Auto-save any unsaved form edits first, then Approve & Create Draft
  el("btn-approve-draft").addEventListener("click", async () => {
    if (!currentSession) return;
    try {
      showError(null);
      if (isFormDirty) {
        await saveDraftFromForm();
      }
      const updated = await apiCall(
        `/api/sessions/${currentSession.id}/approve-draft`,
        { method: "POST" }
      );
      renderSession(updated);
    } catch (err) {
      showError(err.message, "Step 3 • Gate 1 Approval");
    }
  });

  // Gate 2 Step A: Open confirmation summary before sending
  el("btn-approve-send").addEventListener("click", () => {
    if (!currentSession || currentSession.flow.stage !== "draft_created") return;
    const d = currentSession.draft;
    const currCode = d.currency.value || "USD";
    const sym = getCurrencySymbol(currCode);
    const total = computeInvoiceTotal();

    const recipientText = d.recipientName.value
      ? `${d.recipientName.value} (${d.recipientEmail.value})`
      : d.recipientEmail.value || "—";
    const termsText = d.dueDate.value
      ? `Due on ${d.dueDate.value}`
      : TERM_LABELS[d.paymentTerm.value] || d.paymentTerm.value || "—";

    el("confirm-recipient").textContent = recipientText;
    el("confirm-amount").textContent = `${currCode} ${sym}${total.toFixed(2)} (${editableItems.length} item${
      editableItems.length === 1 ? "" : "s"
    })`;
    el("confirm-terms").textContent = termsText;

    el("btn-approve-send").classList.add("hidden");
    el("gate2-confirm-box").classList.remove("hidden");
    el("btn-confirm-send").focus();
  });

  // Gate 2 Step B1: Cancel sending
  el("btn-cancel-send").addEventListener("click", () => {
    el("gate2-confirm-box").classList.add("hidden");
    el("btn-approve-send").classList.remove("hidden");
    el("btn-approve-send").focus();
  });

  // Gate 2 Step B2: Confirm & Send Invoice Now
  el("btn-confirm-send").addEventListener("click", async () => {
    if (!currentSession) return;
    try {
      showError(null);
      const updated = await apiCall(
        `/api/sessions/${currentSession.id}/approve-send`,
        { method: "POST" }
      );
      renderSession(updated);
    } catch (err) {
      showError(err.message, "Step 3 • Gate 2 Send");
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
      showError(err.message, "Step 3 • Refresh Status");
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
      showError(err.message, "Step 3 • Simulate Payment");
    }
  });

  // Highlight quote on field click/focus/hover
  document.querySelectorAll("[data-field]").forEach((node) => {
    const setField = () => {
      activeHighlightField = node.getAttribute("data-field");
      renderProvenanceHighlight();
    };
    node.addEventListener("click", setField);
    node.addEventListener("mouseenter", setField);
    node.addEventListener("focusin", setField);
  });
}

init();
