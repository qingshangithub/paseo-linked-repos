import type { PluginServerContext } from "@getpaseo/plugin/server";
import { diff, panels, related, status, workspaces } from "./server/handlers";
import {
  linkedDiffRpc,
  linkedPanelsRpc,
  linkedRelatedRpc,
  linkedStatusRpc,
  linkedWorkspacesRpc,
} from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  server.handle(linkedWorkspacesRpc, workspaces);
  server.handle(linkedStatusRpc, status);
  server.handle(linkedDiffRpc, diff);
  server.handle(linkedRelatedRpc, related);
  server.handle(linkedPanelsRpc, panels);
  return () => {};
}
