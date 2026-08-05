import { NextResponse } from "next/server";
import { getAllMachineStatuses } from "@/cloud/machines";

export const dynamic = "force-dynamic";

export async function GET() {
  const machines = await getAllMachineStatuses();
  return NextResponse.json({ machines });
}
