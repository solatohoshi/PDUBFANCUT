export interface TextSlot {
  id: string
  text: string
  style: 'caption' | 'lower-third' | 'title'
  /** Position in the same absolute-seconds domain as the video track's total
   * duration — dragged directly on the shared timeline in TimelineTrack.tsx,
   * so it lines up with whichever clip(s) occupy that span. */
  startSecs: number
  durationSecs: number
}

export const STYLE_COLOR: Record<TextSlot['style'], string> = {
  caption:       '#40a0d0',
  'lower-third': '#6c63ff',
  title:         '#f0c020',
}

export const STYLE_LABEL: Record<TextSlot['style'], string> = {
  caption:       'CAPTION',
  'lower-third': 'LOWER-3RD',
  title:         'TITLE',
}
