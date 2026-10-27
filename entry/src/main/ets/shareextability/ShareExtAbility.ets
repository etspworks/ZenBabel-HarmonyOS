import { ShareExtensionAbility, UIExtensionContentSession, Want } from '@kit.AbilityKit';
import { SharedImportStore } from '../common/SharedImportStore';

// The share-panel target, ported from the iOS Share Extension (iOSShareExtension/ShareViewController.swift).
export default class ShareExtAbility extends ShareExtensionAbility {
  onSessionCreate(want: Want, session: UIExtensionContentSession): void {
    SharedImportStore.initialize(this.context);
    const storage: LocalStorage = new LocalStorage();
    storage.setOrCreate<Want>('want', want);
    storage.setOrCreate<UIExtensionContentSession>('session', session);
    session.loadContent('pages/ShareCardPage', storage);
  }
}
