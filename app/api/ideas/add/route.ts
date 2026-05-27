import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { NextRequest, NextResponse } from "next/server";

const WORKBOOK_PATH = join(process.cwd(), "db", "Micro-SaaS Ideas Database [Starter Story].xlsx");

type AddIdeaPayload = {
  idea: string;
  monthlyRevenue: string;
  monthlyTraffic: string;
  revenuePerVisitor: string;
  startingCosts: string;
  solopreneurScore: string;
  icp: string;
  growthTactics: string;
  validationReason: string;
  aiValidation?: {
    isValid?: boolean;
    score?: number;
    summary?: string;
  };
};

function cellText(value: unknown): string {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : "—";
}

export async function POST(req: NextRequest) {
  let payload: AddIdeaPayload;
  try {
    payload = (await req.json()) as AddIdeaPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!payload.idea?.trim()) {
    return NextResponse.json({ error: "Idea name is required." }, { status: 400 });
  }

  try {
    const fileBuffer = await readFile(WORKBOOK_PATH);
    const workbook = XLSX.read(fileBuffer, { type: "buffer" });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];

    const range = XLSX.utils.decode_range(worksheet["!ref"] ?? "A1");

    const incomingName = payload.idea.trim().toLowerCase();
    for (let r = range.s.r; r <= range.e.r; r++) {
      const cell = worksheet[XLSX.utils.encode_cell({ r, c: 0 })];
      if (cell && String(cell.v ?? "").trim().toLowerCase() === incomingName) {
        return NextResponse.json({ error: "This idea already exists in the database." }, { status: 409 });
      }
    }

    const nextRow = range.e.r + 1;

    const row = [
      cellText(payload.idea),
      cellText(payload.monthlyRevenue),
      cellText(payload.monthlyTraffic),
      cellText(payload.revenuePerVisitor),
      cellText(payload.startingCosts),
      cellText(payload.solopreneurScore),
      cellText(payload.icp),
      cellText(payload.growthTactics),
      cellText(payload.validationReason),
      cellText(payload.aiValidation?.summary),
      cellText(payload.aiValidation?.score),
    ];

    XLSX.utils.sheet_add_aoa(worksheet, [row], { origin: `A${nextRow + 1}` });

    const output = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    await writeFile(WORKBOOK_PATH, output);

    return NextResponse.json({
      message: "Idea validated and added to spreadsheet.",
      rowNumber: nextRow + 1,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to write to spreadsheet." },
      { status: 500 },
    );
  }
}
