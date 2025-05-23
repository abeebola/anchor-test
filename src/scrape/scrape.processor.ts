import { HttpService } from '@nestjs/axios';
import { InjectFlowProducer, Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { FlowChildJob, FlowProducer, Job } from 'bullmq';
import { Repository } from 'typeorm';
import { roundToPrecision } from '../common/utils/amounts';
import { AppConfig } from '../config/app';
import { BookEntity } from './book.entity';
import { ScrapeRequestEntity } from './scrape-request.entity';
import { EnrichDataJob } from './scrape.dto';
import { getNewBrowserContext } from './utils/browser';
import { run } from './utils/openai';
import { getBookDescription, getSearchResults } from './utils/scraper';

@Processor('book-queue')
export class ScrapeConsumer extends WorkerHost {
  constructor(
    @InjectRepository(BookEntity)
    private readonly repository: Repository<BookEntity>,
    @InjectFlowProducer('book-producer')
    private readonly bookProducer: FlowProducer,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {
    super();
  }

  async process(job: Job<any, any, string>) {
    console.info(`Running ${job.name} job`);

    switch (job.name) {
      case 'fetch-books':
        return await this.fetchBooks(job.data);

      case 'fetch-description':
        return await this.fetchDescription(job.data);

      case 'enrich-book-data':
        return await this.enrichBookData(job);

      case 'send-google-sheet':
        return await this.sendToGoogleSheet(job);

      case 'update-scrape-request':
        return await this.updateScrapeRequest(job);
    }
  }

  async fetchBooks(data: EnrichDataJob) {
    const { requestId, theme } = data;

    let result: BookEntity[][];

    try {
      result = await Promise.all(
        [1, 2].map((page) => getSearchResults(theme, page)),
      );
    } catch (error) {
      console.error(error);
      await this.repository.manager.update(ScrapeRequestEntity, requestId, {
        status: 'failed',
      });

      return;
    }

    const books = result.flat().map((book) => ({ ...book, requestId }));

    if (!books.length) {
      console.info('No books found.');
      await this.repository.manager.update(ScrapeRequestEntity, requestId, {
        status: 'done',
      });

      return;
    }

    /*
    Looks like a good balance between the number of tabs to open
    for each background job worker and the amount of books to
    process at once using OpenAI. This can be tweaked as needed
    depending on whether we want to optimise for CPU/memory or
    for cost (per OpenAI prompt).
    Could be set using an environment variable instead.
    */
    const BATCH_SIZE = 6;

    const childJobs: FlowChildJob[] = [];

    while (books.length) {
      const batchAmount = Math.min(books.length, BATCH_SIZE);
      const batch = books.splice(0, batchAmount);
      childJobs.push({
        name: 'fetch-description',
        queueName: 'book-queue',
        data: batch,
      });
    }

    await this.bookProducer.add({
      name: 'send-google-sheet',
      queueName: 'book-queue',
      children: [
        {
          name: 'update-scrape-request',
          queueName: 'book-queue',
          children: [
            {
              name: 'enrich-book-data',
              queueName: 'book-queue',
              children: childJobs,
              opts: { removeOnComplete: true },
            },
          ],
          opts: { removeOnComplete: true },
        },
      ],
      opts: { removeOnComplete: true },
    });
  }

  async fetchDescription(books: BookEntity[]): Promise<BookEntity[]> {
    const context = await getNewBrowserContext();
    const results = await Promise.all(
      books.map(async (book) => {
        const page = await context.newPage();

        const description = await getBookDescription(page, book.url);

        book.description = description ?? '';

        return book;
      }),
    );

    void context.close();

    return results;
  }

  async enrichBookData(job: Job<any, any, string>) {
    const childValues = await job.getChildrenValues();

    const bookResults: BookEntity[][] = Object.values(childValues);

    const updatedBooksPromises = bookResults.map(async (books) => {
      const response = await run(books);

      console.log('Response', response);

      const responseMap: Map<string, any> = new Map(
        response.map((x) => [x.id, x]),
      );

      return books.map((book) => {
        const entry = responseMap.get(book.id);

        book.author = entry.authors || null;
        book.discountAmount = roundToPrecision(entry.discountAmount);
        book.discountPercentage = roundToPrecision(entry.discountPercentage);
        book.relevanceScore = roundToPrecision(entry.relevanceScore);
        book.summary = entry.summary;
        book.valueScore = roundToPrecision(entry.valueScore);

        return book;
      });
    });

    try {
      console.log('Resolving promises..');
      const resolved = await Promise.all(updatedBooksPromises);

      const allBooks = resolved.flat();

      console.info('Done enriching data.');
      return allBooks;
    } catch (error) {
      console.error(error);
    }
  }

  async updateScrapeRequest(job: Job<any, any, string>) {
    const childValues = await job.getChildrenValues();

    const books: BookEntity[] = Object.values(childValues)[0];

    if (!books?.length) return;

    console.info('Updating request status with ID:', books[0].requestId);

    try {
      await this.repository.manager.transaction(async (trx) => {
        await trx.insert(BookEntity, books);

        await trx.update(ScrapeRequestEntity, books[0].requestId, {
          status: 'done',
        });
      });

      console.info('Done.');

      return books;
    } catch (error) {
      console.error(error);

      throw error;
    }
  }

  async sendToGoogleSheet(job: Job<any, any, string>) {
    const childValues = await job.getChildrenValues();

    const books: BookEntity[] = Object.values(childValues)[0];

    if (!books?.length) return;

    const webhookUrl =
      this.configService.getOrThrow<AppConfig>('app').makeWebhookUrl;

    try {
      await this.httpService.axiosRef.post(webhookUrl, {
        rows: books.map((book) => ({
          Title: book.title,
          Author: book.author ?? '',
          Description: book.description,
          Summary: book.summary,
          'Current Price': book.currentPrice,
          'Original Price': book.originalPrice,
          'Discount Amount': book.discountAmount,
          'Discount %': book.discountPercentage,
          'Value Score': book.valueScore,
          'Relevance Score': book.relevanceScore,
          URL: book.url,
        })),
      });

      console.info('Data sent to make.com.');
    } catch (error) {
      console.error(error);

      throw error;
    }
  }
}
