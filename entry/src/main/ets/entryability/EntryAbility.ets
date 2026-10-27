import { AbilityConstant, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { TranslationViewModel } from '../common/TranslationViewModel';
import { ImportService } from '../common/ImportService';
import { SharedImportStore } from '../common/SharedImportStore';
import { LaunchArguments } from '../common/LaunchArguments';

export default class EntryAbility extends UIAbility {
  private readonly viewModel: TranslationViewModel = new TranslationViewModel();
  private readonly importService: ImportService = new ImportService(this.viewModel);
  private ready: Promise<void> = Promise.resolve();
  private intake: Promise<void> = Promise.resolve();
  private targetPage: string = 'pages/TranslationViewPage';
  private windowStage?: window.WindowStage;
  private destroyed: boolean = false;

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    try {
      this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
    } catch (error) {
      hilog.error(0, 'ZenBabel', 'Color mode: %{public}s', (error as Error).message);
    }
    this.targetPage = this.resolveTargetPage(want.parameters?.targetPage);
    this.viewModel.applyLaunchInputText(LaunchArguments.extractLaunchInputText(
      LaunchArguments.parse(want.parameters?.[LaunchArguments.PARAMETER])));
    AppStorage.setOrCreate<TranslationViewModel>('translationViewModel', this.viewModel);
    AppStorage.setOrCreate<ImportService>('translationImportService', this.importService);
    this.ready = this.initialize();
    this.acceptWant(want);
  }

  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    this.targetPage = this.resolveTargetPage(want.parameters?.targetPage);
    this.acceptWant(want);
    if (typeof want.parameters?.targetPage === 'string') { this.loadTargetPage(); }
  }

  private resolveTargetPage(targetPage: Object | undefined): string {
    if (targetPage === 'screen_translation' || targetPage === 'TranslationView' ||
      targetPage === 'TranslationViewPage' || targetPage === 'pages/TranslationViewPage') {
      return 'pages/TranslationViewPage';
    }
    return 'pages/TranslationViewPage';
  }

  private async initialize(): Promise<void> {
    SharedImportStore.initialize(this.context);
    // Initialize the production graph before new Want content enters unified intake.
    await this.viewModel.initialize(this.context);
    if (!this.destroyed) { this.importService.initialize(this.context); }
  }

  private acceptWant(want: Want): void {
    this.intake = this.intake.then(async (): Promise<void> => {
      await this.ready;
      if (this.destroyed) { return; }
      await SharedImportStore.intakeWant(want);
      if (this.destroyed) { return; }
      this.viewModel.reloadSettings();
      if (want.uri?.startsWith('prebabellens:')) { await this.viewModel.handleIncomingURL(want.uri); }
      await this.importService.handleSharedImportIfNeeded();
      await this.viewModel.translateIfNeededOnLaunch();
    }).catch((error: Error) => { this.showLifecycleError(error); });
  }

  onForeground(): void {
    this.intake = this.intake.then(async (): Promise<void> => {
      await this.ready;
      if (this.destroyed) { return; }
      this.viewModel.reloadSettings();
      await this.importService.handleSharedImportIfNeeded();
    }).catch((error: Error) => { this.showLifecycleError(error); });
  }

  private showLifecycleError(error: Error): void {
    if (this.destroyed) { return; }
    this.viewModel.errorMessage = error.message;
    this.viewModel.notifyStateChanged();
    hilog.error(0, 'ZenBabel', 'Lifecycle intake: %{public}s', error.message);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    this.windowStage = windowStage;
    this.loadTargetPage();
  }

  private loadTargetPage(): void {
    this.windowStage?.loadContent(this.targetPage, (error) => {
      if (error.code) { this.showLifecycleError(new Error(error.message)); }
    });
  }

  onWindowStageDestroy(): void { this.windowStage = undefined; }

  onDestroy(): void {
    this.destroyed = true;
    this.importService.dispose();
    this.viewModel.stopTranslation();
    AppStorage.delete('translationImportService');
    AppStorage.delete('translationViewModel');
  }
}
