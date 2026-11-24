'use client';

import dynamic from 'next/dynamic';

const HKMAudioSystem = dynamic(() => import('@/hkm/App'), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-[#0c1015] text-[#94a3b8]">
      <div className="relative h-16 w-16">
        <div className="absolute inset-0 rounded-full border-2 border-[#26313e]" />
        <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-[#2dd4bf]" />
      </div>
      <div className="text-center">
        <p className="font-[family-name:var(--font-display)] text-sm font-semibold tracking-[0.2em] text-[#e2e8f0] uppercase">
          HKM Audio System
        </p>
        <p className="mt-2 font-[family-name:var(--font-mono)] text-xs tracking-wider">
          Initializing DSP engine &amp; console surface…
        </p>
      </div>
    </div>
  ),
});

export default function Home() {
  return <HKMAudioSystem />;
}
