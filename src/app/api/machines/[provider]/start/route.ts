import { NextResponse } from "next/server";
import { isCloudProvider } from "@/types";
import { startMachine, statusCodeFor } from "@/cloud/machines";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!isCloudProvider(provider)) {
    return NextResponse.json({ ok: false, message: "Unknown provider." }, { status: 400 });
  }

  const result = await startMachine(provider);
  return NextResponse.json(result, { status: statusCodeFor(result) });
}
