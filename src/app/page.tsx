import { getAllMachineStatuses } from "@/cloud/machines";
import Dashboard from "@/components/Dashboard";

export const dynamic = "force-dynamic";

export default async function Home() {
  const initialMachines = await getAllMachineStatuses();
  return <Dashboard initialMachines={initialMachines} />;
}
