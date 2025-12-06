import Box from "@mui/material/Box";
import { PropsWithChildren } from "react";

// Provides a gooey / liquid animated background using SVG filter and animated blob divs.
export default function GooBackground({ children }: PropsWithChildren) {
  return (
    <Box sx={{ position: "relative", minHeight: "100vh", overflow: "hidden" }}>
      <svg style={{ position: "absolute", width: 0, height: 0 }}>
        <filter id="goo">
          <feGaussianBlur in="SourceGraphic" stdDeviation="12" result="blur" />
          <feColorMatrix
            in="blur"
            mode="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -8"
            result="goo"
          />
          <feBlend in="SourceGraphic" in2="goo" />
        </filter>
      </svg>
      <Box className="goo-canvas" sx={{ position: "absolute", inset: 0, filter: "url(#goo)", zIndex: 0 }}>
        <Box className="blob blob-a" />
        <Box className="blob blob-b" />
        <Box className="blob blob-c" />
      </Box>
      <Box sx={{ position: "relative", zIndex: 1 }}>{children}</Box>
    </Box>
  );
}
