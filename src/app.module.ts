import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './main/prisma/prisma.service';
import { PrismaModule } from './main/prisma/prisma.module';
import { AuthModule } from './main/auth/auth.module';
import { MailService } from './main/mail/mail.service';
import { ContactModule } from './main/contact/contact.module';
import { FAQModule } from './main/faq/faq.module';
import { TermsModule } from './main/terms/terms.module';
import { PlanModule } from './main/plan/plan.module';
import { SubscriptionModule } from './main/subscription/subscription.module';
import { UserModule } from './main/user/user.module';
import { ConfigModule } from '@nestjs/config';
import { TwilioService } from './main/twilio/twilio.service';
import { TwilioModule } from './main/twilio/twilio.module';
import { ChatModule } from './main/chat/chat.module';

import { OnboardingModule } from './main/onboarding/onboarding.module';
import { PropertyModule } from './main/property/property.module';
import { ExchangeRequestModule } from './main/exchange-request/exchange-request.module';
import { StripePaymentModule } from './main/stripe-payment/stripe-payment.module';
import { ReviewModule } from './main/review/review.module';
import { ArticleModule } from './main/article/article.module';
import { BadgeModule } from './main/badge/badge.module';
import { WebSubscribeModule } from './main/web-subscribe/web-subscribe.module';
import { SeederService } from './common/seeder/seed';
import { PromotionalMailService } from './main/mail/another.mail.setup';
import { ScheduleModule } from '@nestjs/schedule';
import { SessionCleanupService } from './utils/multer/taskService';
import { NotificationModule } from './main/notification/notification.module';
import { FeaturedPropertyModule } from './main/featured-property/featured-property.module';
import { VacanzaProtectModule } from './main/vacanza-protect/vacanza-protect.module';
import { CallModule } from './main/call/call.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    AuthModule,
    ContactModule,
    FAQModule,
    TermsModule,
    PlanModule,
    SubscriptionModule,
    UserModule,
    TwilioModule,
    ChatModule,
    ArticleModule,
    OnboardingModule,
    PropertyModule,
    ExchangeRequestModule,
    StripePaymentModule,
    ReviewModule,
    BadgeModule,
    WebSubscribeModule,
    NotificationModule,
    FeaturedPropertyModule,
    VacanzaProtectModule,
    CallModule,
  ],
  controllers: [AppController],
  providers: [AppService, PrismaService, MailService, TwilioService, SeederService, SessionCleanupService],
})
export class AppModule { }
