import { createFileRoute } from "@tanstack/react-router";
import { Workbench } from "@/components/studio/workbench";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <Workbench />;
}
