@Entry
@Component
struct Index {
  @State curr_index: number = 0;
  @State randomIndex: number = 0;
  private strList: string[] = ["Test ABC", "Test 123", "ABC 123", "ABC Test", "123 Test"];
  @State message: string = "Test ABC";

  build() {
    RelativeContainer() {
      Text(this.message)
        .id('HelloWorld')
        .fontSize($r('app.float.page_text_font_size'))
        .fontWeight(FontWeight.Bold)
        .alignRules({
          center: { anchor: '__container__', align: VerticalAlign.Center },
          middle: { anchor: '__container__', align: HorizontalAlign.Center }
        })
        .onClick(() => {
          // let kelimesini kaldırdık, doğrudan var olan state'e atama yapıyoruz:
          do {
            this.randomIndex = Math.floor(Math.random() * this.strList.length);
          } while (this.curr_index === this.randomIndex)

          this.curr_index = this.randomIndex;
          this.message = this.strList[this.curr_index];
        })
    }
    .height('100%')
    .width('100%')
  }
}