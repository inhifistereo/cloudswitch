import { NextResponse } from "next/server";
import { getAllMachineStatuses } from "@/cloud/machines";
import { rejectCrossOrigin } from "@/lib/csrf";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;

  const machines = await getAllMachineStatuses();
  return NextResponse.json({ machines });
}
