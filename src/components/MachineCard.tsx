"use client";

import { useEffect, useRef } from "react";
import type { MachinePowerState, MachineStatus, SecurityPostureState } from "@/types";

const POWER_STATE_LABELS: Record<MachinePowerState, string> = {
  running: "Running",
  stopped: "Stopped",
  starting: "Starting",
  stopping: "Stopping",
  pending: "Pending",
  deallocated: "Deallocated",
  unknown: "Unknown",
  unavailable: "Unavailable",
};

const POSTURE_META: Record<SecurityPostureState, { label: string; className: string }> = {
  expected: { label: "Expected exposure", className: "posture-expected" },
  restricted: { label: "Restricted exposure", className: "posture-restricted" },
  warning: { label: "Warning", className: "posture-warning" },
  unable_to_verify: { label: "Unable to verify", className: "posture-unknown" },
};

function canStart(state: MachinePowerState): boolean {
  return state === "stopped" || state === "deallocated";
}

function canStop(state: MachinePowerState): boolean {
  return state === "running" || state === "starting" || state === "pending";
}

interface MachineCardProps {
  machine: MachineStatus;
  busy: boolean;
  confirmingStop: boolean;
  feedback?: string;
  onStart: () => void;
  onRequestStop: () => void;
  onConfirmStop: () => void;
  onCancelStop: () => void;
}

export default function MachineCard({
  machine,
  busy,
  confirmingStop,
  feedback,
  onStart,
  onRequestStop,
  onConfirmStop,
  onCancelStop,
}: MachineCardProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const headingId = `${machine.provider}-name`;

  useEffect(() => {
    if (confirmingStop) confirmButtonRef.current?.focus();
  }, [confirmingStop]);

  const startDisabled = busy || !machine.configured || !canStart(machine.powerState);
  const stopDisabled = busy || !machine.configured || !canStop(machine.powerState);

  return (
    <article className="machine-card" aria-labelledby={headingId}>
      <h2 id={headingId}>
        {machine.name} <span className="provider-badge">{machine.provider.toUpperCase()}</span>
      </h2>

      <dl className="machine-facts">
        <div>
          <dt>Status</dt>
          <dd>
            <span key={machine.powerState} className="status-value">
              {POWER_STATE_LABELS[machine.powerState]}
            </span>
            {busy && <span className="watching-dot" aria-hidden="true" title="Auto-updating, no need to refresh" />}
          </dd>
        </div>
        <div>
          <dt>Public address</dt>
          <dd>{machine.publicAddress ?? "not available"}</dd>
        </div>
        <div>
          <dt>WireGuard port</dt>
          <dd>{machine.wireguardPort ? `${machine.wireguardPort}/udp` : "—"}</dd>
        </div>
      </dl>

      {machine.securityPosture && (
        <div className={`posture-badge ${POSTURE_META[machine.securityPosture.state].className}`}>
          <p className="posture-label">{POSTURE_META[machine.securityPosture.state].label}</p>
          <ul>
            {machine.securityPosture.findings.slice(0, 2).map((finding) => (
              <li key={finding}>{finding}</li>
            ))}
            {machine.securityPosture.findings.length > 2 && (
              <li>+{machine.securityPosture.findings.length - 2} more</li>
            )}
          </ul>
        </div>
      )}

      {!machine.configured && machine.message && <p className="not-configured">{machine.message}</p>}

      {confirmingStop ? (
        <div
          className="confirm-stop"
          role="alertdialog"
          aria-label={`Confirm stopping ${machine.name}`}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancelStop();
          }}
        >
          <p>Really stop {machine.name}?</p>
          <div className="actions">
            <button ref={confirmButtonRef} type="button" onClick={onConfirmStop} className="danger">
              Confirm
            </button>
            <button type="button" onClick={onCancelStop}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button type="button" onClick={onStart} disabled={startDisabled}>
            Start
          </button>
          <button type="button" onClick={onRequestStop} disabled={stopDisabled}>
            Stop
          </button>
        </div>
      )}

      {feedback && (
        <p role="status" className="feedback">
          {feedback}
          {busy && <span className="watching"> Watching for the status to update above — no need to refresh.</span>}
        </p>
      )}
    </article>
  );
}
