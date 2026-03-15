import "./globals.css";

export const metadata = {
  title: "Goose CLI Chat",
  description: "Streaming client for Goose CLI",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
