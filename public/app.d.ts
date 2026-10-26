import type { DraftUpdatePatch, InvoiceSession } from "../src/workflow.js";
import type { SourceSpan } from "../src/schema.js";

export interface EditableLineItem {
  name: string;
  quantity: string;
  unitPrice: string;
  sourceSpan: SourceSpan | null | undefined;
  isAmbiguous?: boolean;
  clarificationQuestion?: string | null;
}

export interface UiStateSnapshot {
  currentSession: InvoiceSession | null;
  editableItems: EditableLineItem[];
  isFormDirty: boolean;
  activeHighlightField: string | null;
  activeReminderTone?: "gentle" | "professional" | "urgent";
}

export function getUiState(): UiStateSnapshot;
export function setUiStateForTest(next: Partial<UiStateSnapshot>): void;
export function confirmDiscardIfDirty(confirmFn?: (message: string) => boolean): boolean;
export function removeLineItemAt(idx: number, isLocked?: boolean): boolean;
export function updateLineItemField(idx: number, prop: "name" | "quantity" | "unitPrice", newValue: string): void;
export function getFormMissingReasons(): string[];
export function buildPatchFromForm(): DraftUpdatePatch;
export function setActiveHighlightField(fieldKey: string | null): void;
export function renderProvenanceDomOnce(): void;
export function openGate2ConfirmDialog(): boolean;
export function closeGate2ConfirmDialog(): void;
export function openGate3ConfirmDialog(): boolean;
export function closeGate3ConfirmDialog(): void;
export function renderSession(session: InvoiceSession): void;
export function init(): Promise<void>;
