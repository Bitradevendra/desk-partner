import React, { useEffect, useState } from "react";
import { usePetBotStore } from "../../store/usePetBotStore.js";
import { ShieldAlert, Check, X, Lock } from "lucide-react";

export const Touch2FaModal: React.FC = () => {
  const { active2FaChallenge, respondTo2Fa } = usePetBotStore();
  const [secondsRemaining, setSecondsRemaining] = useState(25);

  useEffect(() => {
    if (!active2FaChallenge) {
      setSecondsRemaining(25);
      return;
    }

    const interval = setInterval(() => {
      setSecondsRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          void respondTo2Fa(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [active2FaChallenge, respondTo2Fa]);

  if (!active2FaChallenge) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="relative w-full max-w-md p-6 bg-white border border-zinc-200 rounded-2xl shadow-lg space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2 text-zinc-950">
            <ShieldAlert className="w-5 h-5" strokeWidth={1.75} />
            <span className="text-xs font-semibold uppercase tracking-wider">
              Approval Required
            </span>
          </div>
          <span className="text-xs font-mono text-zinc-600 bg-zinc-100 px-2.5 py-1 rounded-md">
            {secondsRemaining}s left
          </span>
        </div>

        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold text-zinc-950">
            {active2FaChallenge.actionTitle}
          </h2>
          <p className="text-xs text-zinc-600 leading-relaxed">
            Tap Lobo&apos;s physical Right Ear sensor to approve or Left Ear sensor to deny, or choose below.
          </p>
        </div>

        <div className="flex flex-col items-center justify-center p-4 rounded-xl bg-zinc-50 border border-zinc-200 space-y-2 text-center">
          <Lock className="w-6 h-6 text-zinc-800" strokeWidth={1.75} />
          <div className="text-xs font-mono text-zinc-800">Right Ear: Approve · Left Ear: Deny</div>
          <div className="text-[11px] font-mono text-zinc-500">Side Button: More Details</div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => void respondTo2Fa(false)}
            className="flex items-center justify-center space-x-2 py-2.5 rounded-xl bg-white hover:bg-red-50 border border-zinc-300 hover:border-red-300 text-xs font-semibold text-zinc-900 hover:text-red-700"
          >
            <X className="w-4 h-4" />
            <span>Deny</span>
          </button>

          <button
            type="button"
            onClick={() => void respondTo2Fa(true)}
            className="flex items-center justify-center space-x-2 py-2.5 rounded-xl bg-zinc-950 hover:bg-zinc-800 text-xs font-semibold text-white"
          >
            <Check className="w-4 h-4" />
            <span>Approve</span>
          </button>
        </div>
      </div>
    </div>
  );
};
