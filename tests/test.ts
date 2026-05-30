import { describe, it, expect } from "vitest";
import {
  createFork,
  type BranchResult,
  type SelectionFn,
} from "../src/index.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createFork — custom & bare-function selection", () => {
  const branches = [
    { label: "a", value: 1 },
    { label: "b", value: 3 },
    { label: "c", value: 2 },
  ];

  const pickHighest: SelectionFn<number, (typeof branches)[number]> = (
    results,
  ) => {
    const best = [...results]
      .filter((r) => r.status === "fulfilled")
      .sort((x, y) => (y.output ?? 0) - (x.output ?? 0))[0]!;
    return { winner: best.label, scores: { [best.label]: best.output ?? 0 } };
  };

  it("custom mode selects the winner", async () => {
    const result = await createFork({
      branches,
      run: (b) => b.value,
      selection: { mode: "custom", select: pickHighest },
    }).explore();

    expect(result.winner.label).toBe("b");
    expect(result.winner.output).toBe(3);
    expect(result.branches).toHaveLength(3);
  });

  it("bare function behaves identically to { mode: 'custom' }", async () => {
    const result = await createFork({
      branches,
      run: (b) => b.value,
      selection: pickHighest,
    }).explore();

    expect(result.winner.label).toBe("b");
  });
});

describe("createFork — coverage strategy", () => {
  it("scores by facts matched and picks the best", async () => {
    const result = await createFork({
      branches: [
        { label: "diabetes", text: "high glucose and frequent thirst" },
        { label: "cushings", text: "high glucose, thirst, and moon face" },
      ],
      run: (b) => b.text,
      selection: {
        mode: "coverage",
        facts: ["high glucose", "thirst", "moon face"],
      },
    }).explore();

    expect(result.scores["diabetes"]).toBeCloseTo(2 / 3);
    expect(result.scores["cushings"]).toBeCloseTo(3 / 3);
    expect(result.winner.label).toBe("cushings");
  });

  it("gives rejected branches a score of 0 and never picks them", async () => {
    const result = await createFork({
      branches: [
        { label: "good", text: "alpha beta" },
        { label: "boom", text: "" },
      ],
      run: (b) => {
        if (b.label === "boom") throw new Error("nope");
        return b.text;
      },
      selection: { mode: "coverage", facts: ["alpha", "beta"] },
    }).explore();

    expect(result.scores["boom"]).toBe(0);
    expect(result.branches.find((r) => r.label === "boom")!.status).toBe(
      "rejected",
    );
    expect(result.winner.label).toBe("good");
  });

  it("supports a custom extract for non-string output", async () => {
    const result = await createFork({
      branches: [
        { label: "x", facts: ["fever", "cough"] },
        { label: "y", facts: ["fever"] },
      ],
      run: (b) => ({ symptoms: b.facts }),
      selection: {
        mode: "coverage",
        facts: ["fever", "cough"],
        extract: (o) => o.symptoms.join(" "),
      },
    }).explore();

    expect(result.winner.label).toBe("x");
    expect(result.scores["y"]).toBeCloseTo(0.5);
  });
});

describe("createFork — confidence strategy", () => {
  const branches = [
    { label: "hi", text: "I am sure [CONFIDENCE: 0.9] then doubt [CONFIDENCE: 0.3]" },
    { label: "lo", text: "uncertain [CONFIDENCE: 0.4]" },
  ];

  it("aggregates by mean (default)", async () => {
    const result = await createFork({
      branches,
      run: (b) => b.text,
      selection: { mode: "confidence" },
    }).explore();

    expect(result.scores["hi"]).toBeCloseTo(0.6); // (0.9 + 0.3) / 2
    expect(result.scores["lo"]).toBeCloseTo(0.4);
    expect(result.winner.label).toBe("hi");
  });

  it("aggregates by max", async () => {
    const result = await createFork({
      branches,
      run: (b) => b.text,
      selection: { mode: "confidence", aggregate: "max" },
    }).explore();
    expect(result.scores["hi"]).toBeCloseTo(0.9);
  });

  it("aggregates by last", async () => {
    const result = await createFork({
      branches,
      run: (b) => b.text,
      selection: { mode: "confidence", aggregate: "last" },
    }).explore();
    expect(result.scores["hi"]).toBeCloseTo(0.3);
  });

  it("scores 0 when no confidence token is present", async () => {
    const result = await createFork({
      branches: [
        { label: "withTok", text: "[CONFIDENCE: 0.7]" },
        { label: "noTok", text: "no marker here" },
      ],
      run: (b) => b.text,
      selection: { mode: "confidence" },
    }).explore();
    expect(result.scores["noTok"]).toBe(0);
    expect(result.winner.label).toBe("withTok");
  });
});

describe("createFork — judge & human strategies", () => {
  it("invokes the judge callback and honors its winner", async () => {
    let seen = 0;
    const result = await createFork({
      branches: [{ label: "a" }, { label: "b" }],
      run: (b) => b.label,
      selection: {
        mode: "judge",
        judge: (results) => {
          seen = results.length;
          return { winner: "b", reasoning: "b reads better" };
        },
      },
    }).explore();

    expect(seen).toBe(2);
    expect(result.winner.label).toBe("b");
    expect(result.verdict.reasoning).toBe("b reads better");
  });

  it("invokes the human onPresent callback (bare label string)", async () => {
    const result = await createFork({
      branches: [{ label: "a" }, { label: "b" }],
      run: (b) => b.label,
      selection: {
        mode: "human",
        onPresent: async () => "a",
      },
    }).explore();
    expect(result.winner.label).toBe("a");
  });

  it("accepts a full Verdict from human onPresent", async () => {
    const result = await createFork({
      branches: [{ label: "a" }, { label: "b" }],
      run: (b) => b.label,
      selection: {
        mode: "human",
        onPresent: () => ({ winner: "b", reasoning: "operator chose b" }),
      },
    }).explore();
    expect(result.winner.label).toBe("b");
    expect(result.verdict.reasoning).toBe("operator chose b");
  });
});

describe("createFork — ties", () => {
  const tied = {
    branches: [
      { label: "a", text: "alpha beta" },
      { label: "b", text: "alpha beta" },
    ],
    run: (b: { label: string; text: string }) => b.text,
  };

  it("detects a tie and onTie:'first' picks the first tied branch", async () => {
    const result = await createFork({
      ...tied,
      selection: { mode: "coverage", facts: ["alpha", "beta"] },
      onTie: "first",
    }).explore();
    expect(result.winner.label).toBe("a");
    expect(result.verdict.tie).toBe(false);
  });

  it("onTie:'error' throws on a tie", async () => {
    await expect(
      createFork({
        ...tied,
        selection: { mode: "coverage", facts: ["alpha", "beta"] },
        onTie: "error",
      }).explore(),
    ).rejects.toThrow(/tied between/i);
  });

  it("breaks a coverage tie with a fallback judge strategy", async () => {
    const result = await createFork({
      ...tied,
      selection: { mode: "coverage", facts: ["alpha", "beta"] },
      onTie: {
        mode: "judge",
        judge: (results) => ({
          winner: results[results.length - 1]!.label,
          reasoning: "judge broke the tie",
        }),
      },
    }).explore();

    expect(result.winner.label).toBe("b");
    expect(result.verdict.reasoning).toBe("judge broke the tie");
    // primary coverage scores are preserved for transparency
    expect(result.scores["a"]).toBeCloseTo(1);
    expect(result.scores["b"]).toBeCloseTo(1);
  });
});

describe("createFork — concurrency", () => {
  function tracker() {
    let inFlight = 0;
    let max = 0;
    return {
      run: async () => {
        inFlight++;
        max = Math.max(max, inFlight);
        await delay(20);
        inFlight--;
        return "x";
      },
      get max() {
        return max;
      },
    };
  }

  const four = [{ label: "1" }, { label: "2" }, { label: "3" }, { label: "4" }];
  const first: SelectionFn<string> = (r) => ({ winner: r[0]!.label });

  it("runs all branches in parallel by default", async () => {
    const t = tracker();
    await createFork({ branches: four, run: t.run, selection: first }).explore();
    expect(t.max).toBe(4);
  });

  it("caps in-flight workers at concurrency: 1", async () => {
    const t = tracker();
    await createFork({
      branches: four,
      run: t.run,
      selection: first,
      concurrency: 1,
    }).explore();
    expect(t.max).toBe(1);
  });

  it("caps in-flight workers at concurrency: 2", async () => {
    const t = tracker();
    await createFork({
      branches: four,
      run: t.run,
      selection: first,
      concurrency: 2,
    }).explore();
    expect(t.max).toBe(2);
  });
});

describe("createFork — failure handling", () => {
  it("isolates a failing branch and still scores the rest", async () => {
    const result = await createFork({
      branches: [{ label: "ok" }, { label: "bad" }],
      run: (b) => {
        if (b.label === "bad") throw new Error("kaboom");
        return "fine";
      },
      selection: (r) => ({
        winner: r.find((x) => x.status === "fulfilled")!.label,
      }),
    }).explore();

    const bad = result.branches.find((r) => r.label === "bad")!;
    expect(bad.status).toBe("rejected");
    expect(bad.error?.message).toBe("kaboom");
    expect(result.winner.label).toBe("ok");
  });

  it("throws when every branch fails", async () => {
    await expect(
      createFork({
        branches: [{ label: "a" }, { label: "b" }],
        run: () => {
          throw new Error("all dead");
        },
        selection: (r) => ({ winner: r[0]!.label }),
      }).explore(),
    ).rejects.toThrow(/every branch failed/i);
  });
});

describe("createFork — validation", () => {
  const noop: SelectionFn<unknown> = (r) => ({ winner: r[0]!.label });

  it("rejects an empty branch list", () => {
    expect(() =>
      createFork({ branches: [], run: () => 1, selection: noop }),
    ).toThrow(/non-empty/i);
  });

  it("rejects duplicate labels", () => {
    expect(() =>
      createFork({
        branches: [{ label: "x" }, { label: "x" }],
        run: () => 1,
        selection: noop,
      }),
    ).toThrow(/duplicate/i);
  });

  it("rejects concurrency below 1", () => {
    expect(() =>
      createFork({
        branches: [{ label: "x" }],
        run: () => 1,
        selection: noop,
        concurrency: 0,
      }),
    ).toThrow(/concurrency/i);
  });
});

describe("createFork — abort", () => {
  it("rejects when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createFork({
        branches: [{ label: "a" }],
        run: async () => {
          await delay(50);
          return "x";
        },
        selection: (r) => ({ winner: r[0]!.label }),
        signal: controller.signal,
      }).explore(),
    ).rejects.toThrow();
  });
});

describe("createFork — nested forking", () => {
  it("supports a branch whose run() itself forks", async () => {
    const outer = await createFork({
      branches: [{ label: "outerA" }, { label: "outerB" }],
      run: async (b) => {
        const inner = await createFork({
          branches: [
            { label: `${b.label}-1`, n: 1 },
            { label: `${b.label}-2`, n: 5 },
          ],
          run: (c) => c.n,
          selection: (r) => {
            const best = [...r].sort(
              (x, y) => (y.output ?? 0) - (x.output ?? 0),
            )[0]!;
            return { winner: best.label };
          },
        }).explore();
        return inner.winner.output ?? 0;
      },
      selection: (r: BranchResult<number>[]) => {
        const best = [...r].sort((x, y) => (y.output ?? 0) - (x.output ?? 0))[0]!;
        return { winner: best.label };
      },
    }).explore();

    expect(outer.winner.output).toBe(5);
  });
});
