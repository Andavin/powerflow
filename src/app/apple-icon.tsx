import { ImageResponse } from "next/og";

// iOS "Add to Home Screen" icon. Without an apple-touch-icon, iOS falls back to
// a screenshot / the first letter of the title (the bare "P"). This route
// generates a proper 180×180 PNG and Next emits the <link rel="apple-touch-icon">
// automatically. iOS masks the corners, so we fill the whole square.

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// A lightning bolt in the "solar" amber on the app's near-black background.
const BOLT =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#ffce3a">` +
      `<path d="M11.983 1.907a.75.75 0 0 0-1.292-.657l-8.5 11a.75.75 0 0 0 .592 1.21h5.324l-.61 6.093a.75.75 0 0 0 1.292.657l8.5-11a.75.75 0 0 0-.592-1.21H11.37l.61-6.093Z"/>` +
      `</svg>`,
  );

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "radial-gradient(circle at 50% 42%, #1a2233 0%, #050608 72%)",
        }}
      >
        <img src={BOLT} width={112} height={112} alt="" />
      </div>
    ),
    size,
  );
}
