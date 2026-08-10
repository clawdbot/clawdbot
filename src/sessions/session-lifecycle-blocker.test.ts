import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import {
  beginSessionWorkAdmission,
  cancelSessionWorkAdmissionHandoff,
  consumeSessionWorkAdmissionHandoff,
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
} from "./session-lifecycle-admission.js";

it("blocks later admission until the exact lifecycle blocker releases", async () => {
  const target = {
    scope: "store-code-mode-blocker",
    identities: ["agent:main:blocked", "session-blocked"],
  };
  const admission = await beginSessionWorkAdmission({
    ...target,
    assertAllowed: () => {},
  });
  const blocker = admission.createLifecycleBlocker("code_mode_non_quiescent");
  admission.release();

  await expect(
    beginSessionWorkAdmission({
      ...target,
      assertAllowed: () => {},
    }),
  ).rejects.toThrow("Session still has non-quiescent Code Mode tool work");

  blocker.release();
  const retry = await beginSessionWorkAdmission({
    ...target,
    assertAllowed: () => {},
  });
  retry.release();
});

it("does not let an old blocker release clear a newer blocker", async () => {
  const target = {
    scope: "store-code-mode-blocker-generation",
    identities: ["agent:main:blocker-generation", "session-blocker-generation"],
  };
  const firstAdmission = await beginSessionWorkAdmission({
    ...target,
    assertAllowed: () => {},
  });
  const firstBlocker = firstAdmission.createLifecycleBlocker("code_mode_non_quiescent");
  firstAdmission.release();
  firstBlocker.release();

  const secondAdmission = await beginSessionWorkAdmission({
    ...target,
    assertAllowed: () => {},
  });
  const secondBlocker = secondAdmission.createLifecycleBlocker("code_mode_non_quiescent");
  secondAdmission.release();
  firstBlocker.release();

  await expect(
    beginSessionWorkAdmission({
      ...target,
      assertAllowed: () => {},
    }),
  ).rejects.toThrow("Session still has non-quiescent Code Mode tool work");

  secondBlocker.release();
});

it("interrupts a competing admission when a current turn becomes non-quiescent", async () => {
  const target = {
    scope: "store-code-mode-blocker-competing",
    identities: ["agent:main:blocker-competing", "session-blocker-competing"],
  };
  const owner = await beginSessionWorkAdmission({
    ...target,
    assertAllowed: () => {},
  });
  let competingInterrupted = false;
  let releaseCompeting = () => {};
  const competing = await beginSessionWorkAdmission({
    ...target,
    assertAllowed: () => {},
    onInterrupt: () => {
      competingInterrupted = true;
      releaseCompeting();
    },
  });
  releaseCompeting = competing.release;

  const blocker = owner.createLifecycleBlocker("code_mode_non_quiescent");
  expect(competingInterrupted).toBe(true);
  await competing.released;
  owner.release();
  blocker.release();
});

it("does not execute a lease interrupted by a newly registered blocker", async () => {
  const target = {
    scope: "store-code-mode-blocker-interrupted-run",
    identities: ["agent:main:blocker-interrupted-run", "session-blocker-interrupted-run"],
  };
  const owner = await beginSessionWorkAdmission({
    ...target,
    assertAllowed: () => {},
  });
  const competing = await beginSessionWorkAdmission({
    ...target,
    assertAllowed: () => {},
  });
  const blocker = owner.createLifecycleBlocker("code_mode_non_quiescent");
  blocker.release();
  let ran = false;

  await expect(
    competing.run(async () => {
      ran = true;
    }),
  ).rejects.toMatchObject({
    name: "SessionLifecycleBlockedError",
    kind: "code_mode_non_quiescent",
    message: "Session still has non-quiescent Code Mode tool work; retry after it settles.",
  });
  expect(ran).toBe(false);

  competing.release();
  owner.release();
});

it("contains a throwing competing interruption callback", async () => {
  const target = {
    scope: "store-code-mode-blocker-throwing-interrupt",
    identities: ["agent:main:blocker-throwing-interrupt", "session-blocker-throwing-interrupt"],
  };
  const owner = await beginSessionWorkAdmission({
    ...target,
    assertAllowed: () => {},
  });
  const competing = await beginSessionWorkAdmission({
    ...target,
    assertAllowed: () => {},
    onInterrupt: () => {
      throw new Error("broken interrupt callback");
    },
  });

  const blocker = owner.createLifecycleBlocker("code_mode_non_quiescent");
  await expect(
    beginSessionWorkAdmission({
      ...target,
      assertAllowed: () => {},
    }),
  ).rejects.toThrow("Session still has non-quiescent Code Mode tool work");

  competing.release();
  owner.release();
  blocker.release();
});

it("rejects a pre-created handoff once its session becomes non-quiescent", async () => {
  const target = {
    scope: "store-code-mode-blocker-handoff",
    identities: ["agent:main:blocker-handoff", "session-blocker-handoff"],
  };
  const admission = await beginSessionWorkAdmission({
    ...target,
    assertAllowed: () => {},
  });
  const handoffId = admission.createHandoff();
  const blocker = admission.createLifecycleBlocker("code_mode_non_quiescent");

  expect(() =>
    consumeSessionWorkAdmissionHandoff({
      handoffId,
      ...target,
    }),
  ).toThrow("Session still has non-quiescent Code Mode tool work");

  blocker.release();
  cancelSessionWorkAdmissionHandoff(handoffId);
});

it("rechecks lifecycle blockers after mutation preparation", async () => {
  const target = {
    scope: "store-code-mode-blocker-mutation",
    identities: ["agent:main:blocker-mutation", "session-blocker-mutation"],
  };
  const holder: {
    admission?: Awaited<ReturnType<typeof beginSessionWorkAdmission>>;
    blocker?: ReturnType<
      Awaited<ReturnType<typeof beginSessionWorkAdmission>>["createLifecycleBlocker"]
    >;
  } = {};
  const admission = await beginSessionWorkAdmission({
    ...target,
    assertAllowed: () => {},
    onInterrupt: () => {
      const current = holder.admission;
      if (!current) {
        throw new Error("test admission is unavailable");
      }
      holder.blocker = current.createLifecycleBlocker("code_mode_non_quiescent");
      current.release();
    },
  });
  holder.admission = admission;
  let mutationRan = false;

  await expect(
    runExclusiveSessionLifecycleMutation({
      ...target,
      prepare: async () => {
        await interruptSessionWorkAdmissions({ ...target, timeoutMs: 100 });
      },
      run: async () => {
        mutationRan = true;
      },
    }),
  ).rejects.toThrow("Session still has non-quiescent Code Mode tool work");
  expect(mutationRan).toBe(false);

  holder.blocker?.release();
});

it("shares non-quiescent blockers across duplicate module instances", async () => {
  const first = await importFreshModule<typeof import("./session-lifecycle-admission.js")>(
    import.meta.url,
    "./session-lifecycle-admission.js?scope=session-blocker-a",
  );
  const second = await importFreshModule<typeof import("./session-lifecycle-admission.js")>(
    import.meta.url,
    "./session-lifecycle-admission.js?scope=session-blocker-b",
  );
  const target = {
    scope: "store-code-mode-blocker-duplicate",
    identities: ["agent:main:blocker-duplicate", "session-blocker-duplicate"],
  };
  const admission = await first.beginSessionWorkAdmission({
    ...target,
    assertAllowed: () => {},
  });
  const blocker = admission.createLifecycleBlocker("code_mode_non_quiescent");
  admission.release();

  await expect(
    second.beginSessionWorkAdmission({
      ...target,
      assertAllowed: () => {},
    }),
  ).rejects.toThrow("Session still has non-quiescent Code Mode tool work");

  blocker.release();
});
