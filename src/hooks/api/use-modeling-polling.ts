import { GLOBAL } from "@/constants";
import { useEffect } from "react";
import {
  CurrentModelingStatus,
  currentModelingStore,
  updateCurrentModelingStore,
} from "@/stores/slices/current_modeling_store";
import { addModelingGenerationRecord } from "@/stores/slices/modeling_generation_store";
import { createScopedLogger } from "@/utils/logger";
import { useAtomValue, useSetAtom } from "jotai";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import {
  SupportedFileTypes,
  SupportedModelingModel,
  updateModelViewerStore,
} from "@/stores/slices/model_viewer_store";

const logger = createScopedLogger("useModelingPolling");

const MAX_POLLING_ATTEMPTS = 60;
const MAX_RETRY_COUNT = 3;
const EXCEEDED_MAX_POLLING_ATTEMPTS_ERROR = "Exceeded max polling attempts";
const NORMAL_ERROR = "Normal error";
const MODELING_FAILED_ERROR = "Modeling failed";

export interface ModelingConfigBase<T> {
  url: string;
  getModelUrl: (data: T) => Promise<string>;
  getTextureUrl?: (data: T) => Array<string>;
  isSuccess: (data: T) => boolean;
  isFailed?: (data: T) => boolean;
  fetcher: (params: { apiUrl: string; taskId: string }) => Promise<T>;
}

interface UseModelingPollingProps<T> {
  taskId: string;
  config: ModelingConfigBase<T>;
}

export function useModelingPolling<T>({
  taskId,
  config,
}: UseModelingPollingProps<T>) {
  const t = useTranslations(
    "home.panel.modeling_generation_panel.modeling_generator"
  );

  const currentModeling = useAtomValue(currentModelingStore);
  const updateCurrentModeling = useSetAtom(updateCurrentModelingStore);
  const _addModelingGenerationRecord = useSetAtom(addModelingGenerationRecord);
  const updateModelViewer = useSetAtom(updateModelViewerStore);

  const [isPolling, setIsPolling] = useState(false);

  const modelingModel = currentModeling.modelingSettings.modelingModel;
  const modelingStatus = currentModeling.status;
  const modelingFormat = currentModeling.modelingSettings.modelingFormat;
  const shouldStartPolling =
    modelingModel !== "Trellis" &&
    taskId !== "" &&
    modelingStatus === CurrentModelingStatus.PENDING;
  const hasTextures = modelingModel === "Hyper3D" && modelingFormat !== "glb";

  const fetcher = async (apiUrl: string, taskId: string) => {
    if (currentModeling.attempt >= MAX_POLLING_ATTEMPTS) {
      logger.error(EXCEEDED_MAX_POLLING_ATTEMPTS_ERROR);
      throw new Error(EXCEEDED_MAX_POLLING_ATTEMPTS_ERROR);
    }

    let data;
    try {
      data = await config.fetcher({ apiUrl, taskId });
    } catch (error) {
      logger.error(error);
      throw new Error(NORMAL_ERROR);
    }

    if (config.isFailed && config.isFailed(data)) {
      throw new Error(MODELING_FAILED_ERROR);
    }

    updateCurrentModeling({
      ...currentModeling,
      attempt: currentModeling.attempt + 1,
    });

    return data;
  };

  useSWR(
    shouldStartPolling ? [config.url, taskId] : null,
    ([apiUrl, taskId]) => fetcher(apiUrl, taskId),
    {
      refreshInterval: (latestData: any) =>
        latestData && config.isSuccess(latestData) ? 0 : 5000,
      onSuccess: async (data: any) => {
        if (config.isSuccess(data)) {
          const createAt = Date.now();
          if (currentModeling.taskId !== "") {
            _addModelingGenerationRecord({
              taskId: currentModeling.taskId,
              modelUrl: await config.getModelUrl(data),
              textures: hasTextures ? config.getTextureUrl!(data) : [],
              createAt,
              modelingForm: currentModeling.modelingSettings,
            });
          }
          updateCurrentModeling({
            ...currentModeling,
            attempt: 0,
            taskId: "",
            status: CurrentModelingStatus.SUCCESS,
          });
          updateModelViewer({
            modelUrl: await config.getModelUrl(data),
            textures: hasTextures ? config.getTextureUrl!(data) : [],
            fileType: currentModeling.modelingSettings
              .modelingFormat as SupportedFileTypes,
            modelingModel: currentModeling.modelingSettings
              .modelingModel as SupportedModelingModel,
            key: createAt,
          });
          setIsPolling(false);
          toast.success(t("toast.success"), {
            id: GLOBAL.TOAST_ID.MODELING,
          });

          logger.info("3D modeling success", data);
        }
      },
      onErrorRetry: (error, _key, _config, revalidate, { retryCount }) => {
        logger.info("retryCount", retryCount);

        if (
          error.message === EXCEEDED_MAX_POLLING_ATTEMPTS_ERROR ||
          error.message === MODELING_FAILED_ERROR ||
          retryCount >= MAX_RETRY_COUNT
        ) {
          logger.error(error.message);
          updateCurrentModeling({
            ...currentModeling,
            taskId: "",
            status: CurrentModelingStatus.FAILED,
          });
          setIsPolling(false);
          toast.error(t("toast.failed"), {
            id: GLOBAL.TOAST_ID.MODELING,
          });
          return;
        }

        setTimeout(
          () => revalidate({ retryCount }),
          Math.min(1000 * 2 ** retryCount, 30000)
        );
      },
    }
  );

  useEffect(() => {
    if (shouldStartPolling) {
      setIsPolling(true);
    }
  }, [shouldStartPolling]);

  return {
    isPolling,
    setIsPolling,
  };
}
