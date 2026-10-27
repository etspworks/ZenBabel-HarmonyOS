import { LengthMetrics } from '@kit.ArkUI';

export enum RoundedCorner {
  TOP_START,
  TOP_END,
  BOTTOM_START,
  BOTTOM_END
}

@Component
export struct RoundedCornerShape {
  @Prop corners: RoundedCorner[] = [];
  @Prop radius: number = 0;
  @Prop clipContent: boolean = false;
  @BuilderParam content: () => void;

  build() {
    Stack() { this.content() }
      .borderRadius({
        topStart: LengthMetrics.vp(this.corners.includes(RoundedCorner.TOP_START) ? this.radius : 0),
        topEnd: LengthMetrics.vp(this.corners.includes(RoundedCorner.TOP_END) ? this.radius : 0),
        bottomStart: LengthMetrics.vp(this.corners.includes(RoundedCorner.BOTTOM_START) ? this.radius : 0),
        bottomEnd: LengthMetrics.vp(this.corners.includes(RoundedCorner.BOTTOM_END) ? this.radius : 0)
      })
      .clip(this.clipContent)
  }
}

