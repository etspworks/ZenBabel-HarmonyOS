import { common } from '@kit.AbilityKit';
import { TranslationRequest } from '../model/TranslationModels';
import { TranslationEngine, TranslationEnginePolicy } from './TranslationProtocols';
import { FoundationModelsTranslationEngine, TranslationFrameworkPrimaryTranslationEngine } from './TranslationEngines';

export enum IOSPreferredTranslationEngineMode {
  TRANSLATION_FRAMEWORK = 'translationFramework',
  FOUNDATION_MODELS = 'foundationModels'
}

export class FixedTranslationEnginePolicy implements TranslationEnginePolicy {
  private readonly engine: TranslationEngine;

  constructor(engine: TranslationEngine) {
    this.engine = engine;
  }

  initialize(context: common.Context): void {
    if (this.engine instanceof FoundationModelsTranslationEngine ||
      this.engine instanceof TranslationFrameworkPrimaryTranslationEngine) {
      this.engine.initialize(context);
    }
  }

  resolveEngine(_request: TranslationRequest): TranslationEngine {
    return this.engine;
  }
}

export class IOSAdaptiveTranslationEnginePolicy implements TranslationEnginePolicy {
  private readonly translationFrameworkEngine: TranslationEngine;
  private readonly hybridEngine: TranslationEngine;
  private preferredMode: IOSPreferredTranslationEngineMode = IOSPreferredTranslationEngineMode.TRANSLATION_FRAMEWORK;

  constructor(translationFrameworkEngine: TranslationEngine, hybridEngine: TranslationEngine) {
    this.translationFrameworkEngine = translationFrameworkEngine;
    this.hybridEngine = hybridEngine;
  }

  initialize(context: common.Context): void {
    for (const engine of [this.translationFrameworkEngine, this.hybridEngine]) {
      if (engine instanceof FoundationModelsTranslationEngine ||
        engine instanceof TranslationFrameworkPrimaryTranslationEngine) {
        engine.initialize(context);
      }
    }
  }

  async checkAvailability(): Promise<boolean> {
    if (!(this.hybridEngine instanceof FoundationModelsTranslationEngine)) {
      return false;
    }
    const engine = this.hybridEngine;
    let timeout: number | undefined;
    const timedOut = new Promise<boolean>((resolve: (ready: boolean) => void) => {
      timeout = setTimeout(() => {
        engine.availabilityError = 'Local model availability check timed out';
        resolve(false);
      }, 5000);
    });
    try {
      return await Promise.race([engine.checkAvailability(), timedOut]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  resolveEngine(_request: TranslationRequest): TranslationEngine {
    return this.currentPreferredMode() === IOSPreferredTranslationEngineMode.FOUNDATION_MODELS ?
      this.hybridEngine : this.translationFrameworkEngine;
  }

  setPreferredMode(mode: IOSPreferredTranslationEngineMode): void {
    // Synchronous policy reads/writes run on the ArkTS event loop, replacing the source NSLock.
    this.preferredMode = mode === IOSPreferredTranslationEngineMode.FOUNDATION_MODELS &&
      !this.isFoundationModelsReady ? IOSPreferredTranslationEngineMode.TRANSLATION_FRAMEWORK : mode;
  }

  currentPreferredMode(): IOSPreferredTranslationEngineMode {
    return this.preferredMode === IOSPreferredTranslationEngineMode.FOUNDATION_MODELS && this.isFoundationModelsReady ?
      IOSPreferredTranslationEngineMode.FOUNDATION_MODELS : IOSPreferredTranslationEngineMode.TRANSLATION_FRAMEWORK;
  }

  isFoundationModelsAvailable(): boolean {
    return this.isFoundationModelsReady;
  }

  get foundationModelsAvailable(): boolean {
    return this.isFoundationModelsReady;
  }

  private get isFoundationModelsReady(): boolean {
    return this.hybridEngine instanceof FoundationModelsTranslationEngine && this.hybridEngine.isAvailable;
  }
}
