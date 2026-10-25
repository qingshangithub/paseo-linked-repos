import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createBoundPanels } from "./client/bound-panels";
import { createChooserPanel } from "./client/panel";

export default function contribute(client: PluginClientContext) {
  const bound = createBoundPanels(client);
  client.addWorkspacePanel({
    id: "linked-repos",
    title: "Linked Repos",
    icon: "GitCompare",
    locations: ["workspace", "explorer"],
    Component: createChooserPanel(bound.openTabs),
  });
  client.addCommandCenterItem({
    id: "open-linked-repos",
    title: "Open Linked Repos",
    icon: "GitCompare",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("linked-repos");
    },
  });
  void bound.restore();
  return () => bound.dispose();
}
