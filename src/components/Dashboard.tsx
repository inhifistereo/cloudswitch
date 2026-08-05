"use client";

import { useCallback, useState } from "react";
import type { CloudProvider, MachinePowerState, MachineStatus } from "@/types";
import MachineCard from "@/components/MachineCard";

const STABLE_STATES: MachinePowerState[] = ["running", "stopped", "deallocated", "unavailable"];
const POLL_TOTAL_MS = 90_000;
const POLL_FAST_INTERVAL_MS = 3_000;
const POLL_FAST_WINDOW_MS = 30_000;
const POLL_SLOW_INTERVAL_MS = 5_000;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface DashboardProps {
  initialMachines: MachineStatus[];
}

export default function Dashboard({ initialMachines }: DashboardProps) {
  const [machines, setMachines] = useState<MachineStatus[]>(initialMachines);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<Partial<Record<CloudProvider, boolean>>>({});
  const [confirmingStop, setConfirmingStop] = useState<Partial<Record<CloudProvider, boolean>>>({});
  const [feedback, setFeedback] = useState<Partial<Record<CloudProvider, string>>>({});

  const refresh = useCallback(async () => {
    const res = await fetch("/api/machines");
    const data: { machines: MachineStatus[] } = await res.json();
    setMachines(data.machines);
    return data.machines;
  }, []);

  const handleRefreshClick = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const pollAfterOperation = useCallback(
    async (provider: CloudProvider) => {
      const start = Date.now();
      for (;;) {
        const elapsed = Date.now() - start;
        if (elapsed >= POLL_TOTAL_MS) return;
        await wait(elapsed < POLL_FAST_WINDOW_MS ? POLL_FAST_INTERVAL_MS : POLL_SLOW_INTERVAL_MS);
        const updated = await refresh();
        const current = updated.find((m) => m.provider === provider);
        if (current && STABLE_STATES.includes(current.powerState)) return;
      }
    },
    [refresh]
  );

  const runOperation = useCallback(
    async (provider: CloudProvider, endpoint: "start" | "stop") => {
      setBusy((b) => ({ ...b, [provider]: true }));
      setFeedback((f) => ({ ...f, [provider]: undefined }));
      try {
        const res = await fetch(`/api/machines/${provider}/${endpoint}`, { method: "POST" });
        const result: { ok: boolean; message: string } = await res.json();
        setFeedback((f) => ({ ...f, [provider]: result.message }));
        await refresh();
        if (result.ok) await pollAfterOperation(provider);
      } finally {
        setBusy((b) => ({ ...b, [provider]: false }));
      }
    },
    [refresh, pollAfterOperation]
  );

  const handleStart = useCallback((provider: CloudProvider) => void runOperation(provider, "start"), [runOperation]);

  const handleRequestStop = useCallback((provider: CloudProvider) => {
    setConfirmingStop((c) => ({ ...c, [provider]: true }));
  }, []);

  const handleCancelStop = useCallback((provider: CloudProvider) => {
    setConfirmingStop((c) => ({ ...c, [provider]: false }));
  }, []);

  const handleConfirmStop = useCallback(
    (provider: CloudProvider) => {
      setConfirmingStop((c) => ({ ...c, [provider]: false }));
      void runOperation(provider, "stop");
    },
    [runOperation]
  );

  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <h1>CloudSwitch</h1>
        <button type="button" onClick={handleRefreshClick} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      <section className="machine-grid" aria-label="VPN server machines">
        {machines.map((machine) => (
          <MachineCard
            key={machine.provider}
            machine={machine}
            busy={Boolean(busy[machine.provider])}
            confirmingStop={Boolean(confirmingStop[machine.provider])}
            feedback={feedback[machine.provider]}
            onStart={() => handleStart(machine.provider)}
            onRequestStop={() =>
              machine.powerState === "running"
                ? handleRequestStop(machine.provider)
                : handleConfirmStop(machine.provider)
            }
            onConfirmStop={() => handleConfirmStop(machine.provider)}
            onCancelStop={() => handleCancelStop(machine.provider)}
          />
        ))}
      </section>
    </main>
  );
}
