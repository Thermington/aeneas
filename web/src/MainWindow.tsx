import { Suspense, type ReactNode } from "react";
import type { Route } from "./lib/router";
import { ScreenStart, Shell, screenOf } from "./components/Shell";
import { ReminderBanner } from "./components/ReminderBanner";
import { ActivityBanner, DigestToast, DiskBanner, MonitorBanner, QuizToast, SensorBanner } from "./components/NotifyBanners";
import { UpdateToast } from "./components/UpdateToast";
import { IfModule, ModuleGate } from "./components/ModuleGate";

/**
 * The main window around a screen: sidebar and tab bar, banners and toasts. A file of its own, loaded only by the main
 * window: the capture window and the Now widget never need it.
 */
export function MainWindow({ route, view }: { route: Route; view: ReactNode }) {
  return (
    <Shell route={route}>
      <div className="banners">
        <ReminderBanner />
        <ActivityBanner />
        <DiskBanner />
        <IfModule id="sensors"><SensorBanner /></IfModule>
        <IfModule id="homelab"><MonitorBanner /></IfModule>
      </div>
      <ModuleGate path={route.path}>
        <Suspense fallback={null}>
          {view}
          <ScreenStart screen={screenOf(route.path).key} />
        </Suspense>
      </ModuleGate>
      <UpdateToast />
      <DigestToast />
      <IfModule id="quiz"><QuizToast /></IfModule>
    </Shell>
  );
}
