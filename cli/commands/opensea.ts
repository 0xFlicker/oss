import fetch from "node-fetch";
import fs from "fs";
import { extension } from "mime-types";
import { Subject, mergeMap, tap } from "rxjs";
import { IMetadata, IMetadataAttribute } from "../metadata";
import { retryWithBackoff } from "../retry";
import { IERC1155__factory } from "../typechain";
import { any } from "hardhat/internal/core/params/argumentTypes";
import { providers } from "ethers";

const GET_ASSETS = "https://api.opensea.io/api/v1/assets";

interface OwnerUser {
  user: {
    username: string;
  };
  profile_img_url: string;
  address: string;
  config: string;
}

interface Owner {
  quantity: string;
  created_date: string;
  owner: OwnerUser;
}

interface AssetEvent {
  asset: CollectionAsset;
  event_type:
    | "created"
    | "successful"
    | "cancelled"
    | "bid_entered"
    | "bid_withdrawn"
    | "transfer"
    | "offer_entered"
    | "approve";
  created_date: string;
  listing_date: string;
  from_account?: OwnerUser;
  to_account?: OwnerUser;
  seller?: OwnerUser;
  is_private: boolean;
  payment_token: {
    symbol: "ETH" | "WETH" | "DAI";
    address: string;
    image_url: string;
    name: string;
    decimals: number;
    eth_price: string;
    usd_price: string;
  };
  quantity: string;
  total_price: number;
  collection_slug: string;
  starting_price: string;
  ending_price: string;
}

interface CollectionAsset {
  id: number;
  slug: string;
  token_id: string;
  num_sales: number;
  image_url: string;
  image_original_url: string;
  name: string;
  description: string;
  permalink: string;
  traits: IMetadataAttribute[];
  asset_contract: {
    address: string;
  };
  collection: {
    created_date: string;
    description: string;
    name: string;
    slug: string;
  };
}

interface IOpenSeaMetadata extends IMetadata {
  owners: Owner[];
  events: AssetEvent[];
}

interface OpenSeaPagination {
  next?: string;
  previous?: string;
}

interface GetAssetsResponse extends OpenSeaPagination {
  assets: CollectionAsset[];
}

interface GetAssetEventsResponse extends OpenSeaPagination {
  asset_events: AssetEvent[];
}

interface GetAssetOwnersResponse extends OpenSeaPagination {
  owners: Owner[];
}

async function* fetchWithPagination<T>(
  fetcher: (next?: string) => Promise<
    {
      next?: string;
      previous?: string;
    } & T
  >
) {
  let next: string | undefined = undefined;
  while (true) {
    const result: {
      next?: string;
      previous?: string;
    } & T = await retryWithBackoff(() => fetcher(next), 5, 250);
    yield result;
    if (!result.next) {
      break;
    }
    next = result.next;
  }
}

export async function downloadMetadata({
  collectionSlug,
  apiKey,
}: {
  collectionSlug: string;
  apiKey: string;
}) {
  const incomingAssets = new Subject<CollectionAsset>();

  // join incomingAssets and incomingImages and wait for them to complete
  const finished = Promise.all([
    new Promise<void>((resolve, reject) => {
      incomingAssets
        .asObservable()
        .pipe(
          mergeMap(async (asset) => {
            let imageUrl = new URL(
              asset.image_original_url
                ? asset.image_original_url
                : asset.image_url
            );

            await fs.promises.mkdir(`./.metadata/${collectionSlug}`, {
              recursive: true,
            });
            console.log(`Downloading image for ${asset.name}`);
            return {
              asset,
              imageUrl,
              imageResponse: await Promise.resolve().then(async () => {
                return await retryWithBackoff(
                  async () => {
                    imageUrl.search = "";
                    imageUrl.hostname = "lh3.googleusercontent.com";
                    imageUrl.pathname = `${imageUrl.pathname.replace(
                      "/gae/",
                      "/"
                    )}=d`;
                    const imageResponse = await fetch(imageUrl.toString());
                    if (!imageResponse.ok) {
                      throw new Error(
                        `Failed to download image for ${asset.name}: ${imageResponse.status} ${imageResponse.statusText}`
                      );
                    }
                    return imageResponse;
                  },
                  5,
                  250
                );
              }),
              events: await Promise.resolve().then(async () => {
                const assetEvents: AssetEvent[] = [];
                for await (const result of fetchWithPagination<{
                  asset_events: AssetEvent[];
                }>(async (next) => {
                  return retryWithBackoff(
                    async () => {
                      const queryParameters = new URLSearchParams({
                        ...(next ? { cursor: next } : {}),
                        asset_contract_address: asset.asset_contract.address,
                        token_id: asset.token_id,
                      });

                      const response = await fetch(
                        `https://api.opensea.io/api/v1/events?${queryParameters.toString()}`,
                        {
                          headers: {
                            "X-API-KEY": apiKey,
                          },
                        }
                      );
                      if (response.status === 429) {
                        const retryAfter = parseInt(
                          response.headers.get("retry-after") ?? "0"
                        );
                        if (retryAfter > 0) {
                          console.log(
                            `Rate limited, retrying in ${retryAfter}s`
                          );
                          await new Promise((resolve) =>
                            setTimeout(resolve, retryAfter * 1000)
                          );
                        }
                        throw new Error("Rate limited");
                      }
                      const result = await response.json();
                      return result as GetAssetEventsResponse;
                    },
                    5,
                    250
                  );
                })) {
                  for (const assetEvent of result.asset_events ?? []) {
                    delete assetEvent.asset;
                    assetEvents.push(assetEvent);
                  }
                }
                return assetEvents;
              }),
              owners: await Promise.resolve().then(async () => {
                const owners: Owner[] = [];
                for await (const ownerBatch of fetchWithPagination<{
                  owners: Owner[];
                }>(async (next) => {
                  const queryParameters = new URLSearchParams({
                    ...(next ? { cursor: next } : {}),
                  });

                  const response = await fetch(
                    `https://api.opensea.io/api/v1/asset/${
                      asset.asset_contract.address
                    }/${asset.token_id}/owners?${queryParameters.toString()}`,
                    {
                      headers: {
                        "X-API-KEY": apiKey,
                      },
                    }
                  );
                  if (response.status === 429) {
                    const retryAfter = parseInt(
                      response.headers.get("retry-after") ?? "0"
                    );
                    if (retryAfter > 0) {
                      console.log(`Rate limited, retrying in ${retryAfter}s`);
                      await new Promise((resolve) =>
                        setTimeout(resolve, retryAfter * 1000)
                      );
                    }
                    throw new Error("Rate limited");
                  }
                  return (await response.json()) as GetAssetOwnersResponse;
                })) {
                  for (const owner of ownerBatch.owners ?? []) {
                    owners.push(owner);
                  }
                }
                return owners;
              }),
            };
          }, 1),
          tap(async ({ asset, imageResponse, events, owners }) => {
            console.log(`Writing image for ${asset.name}`);
            const image = Buffer.from(await imageResponse.arrayBuffer());
            const imageFile = `${asset.token_id}.${extension(
              imageResponse.headers.get("content-type") ?? ""
            )}`;
            await fs.promises.writeFile(
              `./.metadata/${asset.collection.slug}/${imageFile}`,
              image
            );
            console.log(`Writing metadata for ${asset.name}`);
            const metadata: IOpenSeaMetadata = {
              name: asset.name,
              description: asset.description,
              image: `./${imageFile}`,
              attributes: asset.traits,
              owners: owners,
              events: events,
            };
            await fs.promises.writeFile(
              `./.metadata/${asset.collection.slug}/${asset.token_id}.json`,
              JSON.stringify(metadata, null, 2),
              "utf8"
            );
          })
        )
        .subscribe({
          complete() {
            console.log("Assets complete");
            resolve();
          },
          error(err) {
            reject(err);
          },
        });
    }),
  ]);

  for await (const batchAssets of fetchWithPagination(async (next) => {
    const queryParameters = new URLSearchParams({
      collection: collectionSlug,
      ...(next ? { cursor: next } : {}),
    });

    const response = await fetch(
      `${GET_ASSETS}?${queryParameters.toString()}`,
      {
        headers: {
          "X-API-KEY": apiKey,
        },
      }
    );
    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get("retry-after") ?? "0");
      if (retryAfter > 0) {
        console.log(`Rate limited, retrying in ${retryAfter}s`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      }
      throw new Error("Rate limited");
    }

    return (await response.json()) as GetAssetsResponse;
  })) {
    console.log(JSON.stringify(batchAssets, null, 2));
    for (const asset of batchAssets.assets ?? []) {
      console.log(`Processing ${asset.name}`);
      incomingAssets.next(asset);
    }
  }

  incomingAssets.complete();
  try {
    await finished;
  } catch (err) {
    console.error(err);
  }
}