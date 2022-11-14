import fs from "fs";
import { resolve as pathResolve, basename, extname } from "path";
import { GiphyFetch } from "@giphy/js-fetch-api";
import { AssetEvent, IOpenSeaMetadata, Owner } from "../metadata";
import { retryWithBackoff } from "../retry";
import { BigNumber } from "ethers";

async function* randomGif(giphyApiKey: string, searchTerm: string) {
  const gf = new GiphyFetch(giphyApiKey);
  const LIMIT = 10;
  async function fetchMore(cursor: number | undefined) {
    return await gf.search(searchTerm, {
      sort: "relevant",
      lang: "en",
      limit: LIMIT,
      type: "stickers",
      offset: cursor,
    });
  }
  let offset = 0;

  do {
    const { data: gifs, pagination } = await fetchMore(offset);
    for (const gif of gifs) {
      if (gif.images.original.url.split("?")[0].endsWith(".gif")) {
        yield gif.images.original.url;
      }
    }
    if (pagination.total_count <= offset + LIMIT) {
      break;
    }
    offset += LIMIT;
  } while (true);
}

const oldestOwnerReducer = (
  prev: AssetEvent | undefined,
  current: AssetEvent
) => {
  if (prev === undefined) {
    return current;
  }
  return prev.created_date < current.created_date ? prev : current;
};

export async function prepareMetadata({
  giphyApiKey,
  giphySearchTerm,
  inDir,
  outDir,
  testImages,
  hunnys,
  mintAttribute,
}: {
  giphyApiKey?: string;
  giphySearchTerm?: string;
  inDir: string;
  outDir: string;
  testImages?: boolean;
  hunnys?: boolean;
  mintAttribute?: boolean;
}) {
  await fs.promises.mkdir(pathResolve(outDir, "assets"), { recursive: true });
  await fs.promises.mkdir(pathResolve(outDir, "metadata"), { recursive: true });
  // Iterate over all JSON files in a directory.
  const filesToParse: string[] = [];
  for await (const dirEntry of await fs.promises.opendir(inDir)) {
    if (dirEntry.isFile() && dirEntry.name.endsWith(".json")) {
      filesToParse.push(dirEntry.name);
    }
  }
  // For each file, read the contents and parse the JSON.
  const metadataJson: IOpenSeaMetadata[] = [];
  for (const file of filesToParse.sort((a, b) =>
    BigNumber.from(basename(a, ".json"))
      .sub(BigNumber.from(basename(b, ".json")))
      .toNumber()
  )) {
    const metadata = JSON.parse(
      await fs.promises.readFile(`${inDir}/${file}`, "utf8")
    );
    metadataJson.push(metadata);
  }

  // Rename each file to the new token ID which is the order of when the token was created
  const gifIterator =
    testImages && giphyApiKey
      ? randomGif(giphyApiKey, giphySearchTerm || "ape")
      : undefined;

  for (let i = 0; i < metadataJson.length; i++) {
    console.log(`Processing ${i + 1} of ${metadataJson.length}`);
    const metadata = metadataJson[i];
    // Find oldest event...
    const oldestEvent = metadata.events?.reduce(oldestOwnerReducer);

    if (gifIterator) {
      const gifImageName = `${i + 1}.gif`;

      // Check if the image already exists
      if (
        !(await fs.promises
          .stat(`${outDir}/${gifImageName}`)
          .catch(() => false))
      ) {
        const next = await gifIterator.next();
        if (next.done) {
          throw new Error("Ran out of GIFs");
        } else {
          console.log(`Downloading ${next.value}`);
          const gifImageResponse = await retryWithBackoff(
            () => fetch(next.value),
            5,
            250
          );
          const gifImageBuffer = Buffer.from(
            await gifImageResponse.arrayBuffer()
          );

          await fs.promises.writeFile(
            `${outDir}/assets/${gifImageName}`,
            gifImageBuffer
          );
        }

        metadata.image = gifImageName;
      }
    } else {
      // Copy over the image
      const image = metadata.image;
      const imageFileExtension = extname(image);
      const newImageFileName = `${i + 1}${imageFileExtension}`;
      metadata.image = newImageFileName;
      await fs.promises.copyFile(
        pathResolve(inDir, image),
        pathResolve(outDir, "assets", newImageFileName)
      );
    }

    //Create a creation date string using a locale formatter
    const creationDate = oldestEvent
      ? new Date(oldestEvent.created_date)
      : undefined;

    const localeCreationDate = creationDate?.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    // Some final custom metadata
    if (hunnys) {
      if (metadata.name.includes("Hunny #")) {
        metadata.attributes?.push({
          trait_type: "Type",
          value: "Classic",
        });
      } else {
        metadata.attributes?.push({
          trait_type: "Type",
          value: "Named",
        });
      }
    }

    if (mintAttribute && localeCreationDate) {
      metadata.attributes?.push({
        trait_type: "Original Mint Date",
        value: localeCreationDate,
      });
    }
    const tokenId = i + 1;
    metadata.id = String(tokenId);
    metadata.original_creation_date = creationDate?.toISOString();
    metadata.description = localeCreationDate
      ? `${metadata.description}

This NFT was originally created on the OpenSea Storefront on ${localeCreationDate}.`
      : metadata.description;

    const newFileName = `${tokenId}.json`;
    await fs.promises.writeFile(
      `${outDir}/metadata/${newFileName}`,
      JSON.stringify(metadata, null, 2),
      "utf8"
    );
  }
}
