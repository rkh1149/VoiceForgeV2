import type { ArchitecturePlan } from "../architecture";
import type { AppSpec } from "../spec";
import type { TemplateCapabilities } from "./template";

export function buildTemplateCapabilities(
  spec: AppSpec,
  architecture: ArchitecturePlan,
): TemplateCapabilities {
  const services = new Set(
    architecture.platformServices
      .filter(
        (service) => service.required && service.availability === "available",
      )
      .map((service) => service.service),
  );
  const profiles = new Set(architecture.dependencyProfile ?? []);
  const usesPlatformData =
    services.has("data") ||
    architecture.dataModel.some((entity) => entity.storage === "platformData");
  const files = spec.fileRequirements.length > 0 || services.has("files");
  const notifications =
    spec.notifications.some((notification) => notification.channel !== "none") ||
    services.has("email") ||
    services.has("jobs");
  const integrations = services.has("integrations");

  return {
    data: usesPlatformData || files || notifications || integrations,
    files,
    ai: spec.aiFeatures.length > 0 || services.has("ai"),
    notifications,
    integrations,
    deviceLocation: services.has("device_location"),
    reusableComponents: profiles.has("advancedInterface"),
    utilityModules:
      profiles.has("dataDisplay") ||
      profiles.has("dateScheduling") ||
      profiles.has("fileExport"),
  };
}
