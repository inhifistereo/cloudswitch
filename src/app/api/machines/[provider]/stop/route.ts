import { NextResponse } from "next/server";
import { isCloudProvider } from "@/types";
import { stopMachine, statusCodeFor } from "@/cloud/machines";
import { rejectCrossOrigin } from "@/lib/csrf";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;

  const { provider } = await params;
  if (!isCloudProvider(provider)) {
    return NextResponse.json({ ok: false, message: "Unknown provider." }, { status: 400 });
  }

  const result = await stopMachine(provider);
  return NextResponse.json(result, { status: statusCodeFor(result) });
}
