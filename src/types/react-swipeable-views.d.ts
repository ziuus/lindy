declare module 'react-swipeable-views' {
  import * as React from 'react';
  interface SwipeableViewsProps {
    index?: number;
    onChangeIndex?: (index: number, prevIndex: number) => void;
    children?: React.ReactNode;
    enableMouseEvents?: boolean;
    style?: React.CSSProperties;
    containerStyle?: React.CSSProperties;
    slideStyle?: React.CSSProperties;
  }
  const SwipeableViews: React.ComponentType<SwipeableViewsProps>;
  export default SwipeableViews;
}
