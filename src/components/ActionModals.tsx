import React, { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface ReasonPromptModalProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void> | void;
}

export const ReasonPromptModal: React.FC<ReasonPromptModalProps> = ({
  open,
  title,
  description,
  confirmLabel = 'Confirm Reversal',
  onCancel,
  onConfirm,
}) => {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setReason('');
      setSubmitting(false);
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reason-modal-title"
        className="bg-white rounded-lg border border-slate-200 shadow-xl w-full max-w-md p-5 space-y-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
            <h2 id="reason-modal-title" className="text-sm font-bold text-slate-900">
              {title}
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close dialog"
            onClick={onCancel}
            className="text-slate-400 hover:text-slate-700"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-600">{description}</p>

        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!reason.trim() || submitting) return;
            setSubmitting(true);
            try {
              await onConfirm(reason.trim());
            } finally {
              setSubmitting(false);
            }
          }}
          className="space-y-3"
        >
          <div>
            <label htmlFor="reversal-reason-input" className="block text-xs font-medium text-slate-700 mb-1">
              Mandatory Audit Reason *
            </label>
            <input
              id="reversal-reason-input"
              type="text"
              required
              autoFocus
              placeholder="e.g., Data entry error, wrong batch, customer cancelled..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!reason.trim() || submitting}
              className="px-4 py-1.5 text-xs font-semibold text-white bg-red-700 hover:bg-red-800 disabled:opacity-50 rounded-md"
            >
              {submitting ? 'Processing...' : confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface ConfirmActionModalProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
}

export const ConfirmActionModal: React.FC<ConfirmActionModalProps> = ({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  onCancel,
  onConfirm,
}) => {
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) setSubmitting(false);
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        className="bg-white rounded-lg border border-slate-200 shadow-xl w-full max-w-md p-5 space-y-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
            <h2 id="confirm-modal-title" className="text-sm font-bold text-slate-900">
              {title}
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close dialog"
            onClick={onCancel}
            className="text-slate-400 hover:text-slate-700"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-600">{description}</p>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={async () => {
              if (submitting) return;
              setSubmitting(true);
              try {
                await onConfirm();
              } finally {
                setSubmitting(false);
              }
            }}
            className="px-4 py-1.5 text-xs font-semibold text-white bg-amber-700 hover:bg-amber-800 disabled:opacity-50 rounded-md"
          >
            {submitting ? 'Working...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
