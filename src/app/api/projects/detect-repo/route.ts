import { NextResponse, type NextRequest } from "next/server";
import { apiErrorResponse } from "@/lib/api/errors";
import { detectDefaultBranch, detectHasRepo } from "@/lib/api/util";
import { repoDetectSchema } from "@/lib/api/validation";

// Re-run git auto-detection against an arbitrary folder path (the value
// currently typed in the project form, which may be unsaved). Lets the form
// refresh `has_repo` without a full save / page reload.
export async function POST(req: NextRequest) {
  try {
    const { folder_path } = repoDetectSchema.parse(await req.json());
    const has_repo = detectHasRepo(folder_path);
    return NextResponse.json({
      has_repo,
      default_branch: has_repo ? detectDefaultBranch(folder_path) : null,
    });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
