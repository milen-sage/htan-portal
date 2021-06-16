# HTAN Data Portal
This repo contains the code for the [Human Tumor Atlas Network Data Portal](https://data.humantumoratlas.org/)

## Framework
This is a [Next.js](https://nextjs.org/) project bootstrapped with [`create-next-app`](https://github.com/zeit/next.js/tree/canary/packages/create-next-app)

## Backend
All data is coming from [Synapse](https://www.synapse.org/). We have a Python script that generates a JSON file that contains all the metadata. There is currently no backend, it's a fully static site i.e. all filtering happens on the frontend.

## Testing

There are currently no automated tests, other than building the project, so be careful when merging to master

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing any page. The page auto-updates as you edit the file.

## Learn More about Next.js

To learn more about Next.js, take a look at the following resources:

-   [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
-   [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

## Deployment

The app is deployed using the [ZEIT Now Platform](https://zeit.co/import?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.
