"use client";

import { useEffect, useState } from "react";
import { FlowScreen } from "./FlowScreen";
import { DesktopDashboard } from "./DesktopDashboard";

/**
 * The home route is the phone Flow view on small screens and the richer desktop
 * dashboard on large ones. We pick a single tree (rather than render both and
 * hide with CSS) so only one live SSE stream is opened.
 */
export function ResponsiveHome() {
  const [isDesktop, setIsDesktop] = useState<boolean | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  if (isDesktop === null) {
    // Pre-measurement: render nothing to avoid opening a stream we'd discard.
    return <div className="min-h-[50vh]" />;
  }
  return isDesktop ? <DesktopDashboard /> : <FlowScreen />;
}
