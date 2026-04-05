# EchoPrivate Secure - Netlify Deployment Guide

This app is ready to be deployed to Netlify.

## Steps to Deploy:

1.  **Connect to GitHub/GitLab/Bitbucket:**
    *   Push your code to a repository.
    *   In the Netlify dashboard, click **"New site from Git"**.
    *   Select your repository.

2.  **Build Settings:**
    *   **Build Command:** `npm run build`
    *   **Publish Directory:** `dist`
    *   **Node.js Version:** 20+ (recommended)

3.  **Environment Variables (Optional):**
    *   If you're using the Gemini API, add `GEMINI_API_KEY` to your Netlify environment variables.
    *   The Firebase configuration is already included in `firebase-applet-config.json` and will be bundled during the build.

4.  **SPA Routing:**
    *   A `netlify.toml` file has been included to handle Single Page Application (SPA) routing. This ensures that refreshing the page on a sub-route (like `/chat`) doesn't result in a 404 error.

## Local Testing

To test the production build locally:

```bash
npm run build
npx serve -s dist
```
