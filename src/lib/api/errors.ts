// Side-effect: registers node-cron schedules once per process when any API
// route module that imports `apiErrorResponse` is loaded. Idempotent via
// globalThis state in `workflow/cron.ts`.
import "@/workflow/boot";

import { NextResponse } from "next/server";
import { ZodError } from "zod";

export type ApiErrorCode =
  | "validation_failed"
  | "not_found"
  | "conflict"
  | "invalid_state"
  | "rule_violation"
  | "internal";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ApiErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function apiErrorResponse(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      { status: err.status },
    );
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "validation_failed",
          message: "invalid request body",
          details: err.flatten(),
        },
      },
      { status: 400 },
    );
  }
  console.error("unhandled api error", err);
  return NextResponse.json(
    { error: { code: "internal", message: "internal server error" } },
    { status: 500 },
  );
}

export function notFound(message = "not found"): never {
  throw new ApiError(404, "not_found", message);
}

export function ruleViolation(message: string, details?: unknown): never {
  throw new ApiError(422, "rule_violation", message, details);
}

export function invalidState(message: string): never {
  throw new ApiError(409, "invalid_state", message);
}
