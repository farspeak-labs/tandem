import { describe, expect, it } from "vitest";
import { cleanCopy } from "../src/export";

describe("cleanCopy", () => {
  it("accepts suggestions and strips comments, highlights and endmatter", () => {
    const md = [
      "# Plan",
      "",
      "Ship in {~~three~>two~~}{#s1} weeks{++ at most++}{#s2}{-- maybe--}{#s3}. See {==this part==}{>>why?<<}{#c1}.{>>overall<<}{#c2}",
      "",
      "- keep",
      "- {--dropped item--}{#s4}",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: Alex",
      "",
    ].join("\n");
    expect(cleanCopy(md)).toBe("# Plan\n\nShip in two weeks at most. See this part.\n\n- keep\n");
  });
});
